import {
  extractGroupMessageContent,
  generateAgentId,
  getDynamicAgentConfig,
  shouldTriggerGroupResponse,
  shouldUseDynamicAgent,
} from "../dynamic-agent.js";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { resolveWecomCommandAuthorized } from "./allow-from.js";
import {
  checkCommandAllowlist,
  getCommandConfig,
  isHighPriorityCommand,
  isWecomAdmin,
} from "./commands.js";
import { SAFETY_NET_IDLE_CLOSE_MS, THINKING_PLACEHOLDER } from "./constants.js";
import { downloadAndDecryptImage, downloadWecomFile, guessMimeType } from "./media.js";
import { deliverWecomReply } from "./outbound-delivery.js";
import {
  dispatchLocks,
  getRuntime,
  messageBuffers,
  resolveAgentConfig,
  responseUrls,
  streamContext,
  streamMeta,
} from "./state.js";
import { handleStreamError, registerActiveStream, unregisterActiveStream } from "./stream-utils.js";
import { ensureDynamicAgentListed } from "./workspace-template.js";

/**
 * Flush the debounce buffer for a given streamKey.
 * Merges buffered messages into a single dispatch call.
 * The first message's stream receives the LLM response.
 * Subsequent streams get "消息已合并到第一条回复" and finish immediately.
 */
export function flushMessageBuffer(streamKey, target) {
  const buffer = messageBuffers.get(streamKey);
  if (!buffer) {
    return;
  }
  messageBuffers.delete(streamKey);

  const { messages, streamIds } = buffer;
  const primaryStreamId = streamIds[0];
  const primaryMsg = messages[0];

  // Merge content from all buffered messages.
  if (messages.length > 1) {
    const mergedContent = messages.map((m) => m.content || "").filter(Boolean).join("\n");
    primaryMsg.content = mergedContent;

    // Merge image attachments.
    const allImageUrls = messages.flatMap((m) => m.imageUrls || []);
    if (allImageUrls.length > 0) {
      primaryMsg.imageUrls = allImageUrls;
    }
    const singleImages = messages.map((m) => m.imageUrl).filter(Boolean);
    if (singleImages.length > 0 && !primaryMsg.imageUrl) {
      primaryMsg.imageUrl = singleImages[0];
      if (singleImages.length > 1) {
        primaryMsg.imageUrls = [...(primaryMsg.imageUrls || []), ...singleImages.slice(1)];
      }
    }

    // Finish extra streams with merge notice.
    for (let i = 1; i < streamIds.length; i++) {
      const extraStreamId = streamIds[i];
      streamManager.replaceIfPlaceholder(
        extraStreamId,
        "消息已合并到第一条回复中。",
        THINKING_PLACEHOLDER,
      );
      streamManager.finishStream(extraStreamId).then(() => {
        unregisterActiveStream(streamKey, extraStreamId);
      });
    }

    logger.info("WeCom: flushing merged messages", {
      streamKey,
      count: messages.length,
      primaryStreamId,
      mergedContentPreview: mergedContent.substring(0, 60),
    });
  } else {
    logger.info("WeCom: flushing single message", { streamKey, primaryStreamId });
  }

  // Dispatch the merged message.
  processInboundMessage({
    message: primaryMsg,
    streamId: primaryStreamId,
    timestamp: buffer.timestamp,
    nonce: buffer.nonce,
    account: target.account,
    config: target.config,
  }).catch(async (err) => {
    logger.error("WeCom message processing failed", { error: err.message });
    await handleStreamError(primaryStreamId, streamKey, "处理消息时出错，请稍后再试。");
  });
}

export async function processInboundMessage({
  message,
  streamId,
  timestamp: _timestamp,
  nonce: _nonce,
  account,
  config,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const msgType = message.msgType || "text";
  const imageUrl = message.imageUrl || "";
  const imageUrls = message.imageUrls || [];
  const fileUrl = message.fileUrl || "";
  const fileName = message.fileName || "";
  const rawContent = message.content || "";
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  const isGroupChat = chatType === "group" && chatId;

  // Use chat id for group sessions and sender id for direct messages.
  const peerId = isGroupChat ? chatId : senderId;
  const peerKind = isGroupChat ? "group" : "dm";
  const conversationId = isGroupChat ? `wecom:group:${chatId}` : `wecom:${senderId}`;

  // Track active stream by chat context for outbound adapter callbacks.
  const streamKey = isGroupChat ? chatId : senderId;
  if (streamId) {
    registerActiveStream(streamKey, streamId);
  }

  // Save response_url for fallback delivery after stream closes.
  // response_url is valid for 1 hour and can be used only once.
  if (message.responseUrl && message.responseUrl.trim()) {
    responseUrls.set(streamKey, {
      url: message.responseUrl,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
      used: false,
    });
    logger.debug("WeCom: saved response_url for fallback", { streamKey });
  }

  // Apply group mention gating rules.
  let rawBody = rawContent;
  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(rawContent, config)) {
      logger.debug("WeCom: group message ignored (no mention)", { chatId, senderId });
      if (streamId) {
        streamManager.replaceIfPlaceholder(streamId, "请@提及我以获取回复。", THINKING_PLACEHOLDER);
        await streamManager.finishStream(streamId);
        unregisterActiveStream(streamKey, streamId);
      }
      return;
    }
    // Strip mention markers from the effective prompt.
    rawBody = extractGroupMessageContent(rawContent, config);
  }

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });

  // Skip empty messages, but allow image/mixed/file messages.
  if (!rawBody.trim() && !imageUrl && imageUrls.length === 0 && !fileUrl) {
    logger.debug("WeCom: empty message, skipping", { msgType });
    if (streamId) {
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  // ========================================================================
  // Command allowlist enforcement
  // Admins bypass the allowlist entirely.
  // ========================================================================
  const senderIsAdmin = isWecomAdmin(senderId, config);
  const commandCheck = checkCommandAllowlist(rawBody, config);

  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    // Return block message when command is outside the allowlist.
    const cmdConfig = getCommandConfig(config);
    logger.warn("WeCom: blocked command", {
      command: commandCheck.command,
      from: senderId,
      chatType: peerKind,
    });

    // Send blocked-command response through the same stream.
    if (streamId) {
      streamManager.replaceIfPlaceholder(streamId, cmdConfig.blockMessage, THINKING_PLACEHOLDER);
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  if (commandCheck.isCommand && !commandCheck.allowed && senderIsAdmin) {
    logger.info("WeCom: admin bypassed command allowlist", {
      command: commandCheck.command,
      from: senderId,
    });
  }

  logger.info("WeCom processing message", {
    from: senderId,
    chatType: peerKind,
    peerId,
    content: rawBody.substring(0, 50),
    streamId,
    isCommand: commandCheck.isCommand,
    command: commandCheck.command,
  });

  const highPriorityCommand = commandCheck.isCommand && isHighPriorityCommand(commandCheck.command);

  // ========================================================================
  // Dynamic agent routing
  // Admins also use dynamic agents; admin flag only affects command allowlist.
  // ========================================================================
  const dynamicConfig = getDynamicAgentConfig(config);

  // Compute deterministic agent target for this conversation.
  const targetAgentId =
    dynamicConfig.enabled && shouldUseDynamicAgent({ chatType: peerKind, config })
      ? generateAgentId(peerKind, peerId)
      : null;

  if (targetAgentId) {
    await ensureDynamicAgentListed(targetAgentId);
    logger.debug("Using dynamic agent", { agentId: targetAgentId, chatType: peerKind, peerId });
  } else if (senderIsAdmin) {
    logger.debug("Admin user, dynamic agent disabled for this chat type; falling back to default route", {
      senderId,
      chatType: peerKind,
    });
  }

  // ========================================================================
  // Resolve route and override with dynamic agent when enabled
  // ========================================================================
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  // Override default route with deterministic dynamic agent session key.
  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Prefix sender id in group contexts so attribution stays explicit.
  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const body = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build context payload with optional image attachment.
  const ctxBase = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wecom:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `Group ${chatId}` : senderId,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  };

  // Download, decrypt, and attach media when present.
  const allImageUrls = imageUrl ? [imageUrl] : imageUrls;

  if (allImageUrls.length > 0) {
    const mediaPaths = [];
    const mediaTypes = [];
    const fallbackUrls = [];

    for (const url of allImageUrls) {
      try {
        const result = await downloadAndDecryptImage(url, account.encodingAesKey, account.token);
        mediaPaths.push(result.localPath);
        mediaTypes.push(result.mimeType);
      } catch (e) {
        logger.warn("Image decryption failed, using URL fallback", {
          error: e.message,
          url: url.substring(0, 80),
        });
        fallbackUrls.push(url);
        mediaTypes.push("image/jpeg");
      }
    }

    if (mediaPaths.length > 0) {
      ctxBase.MediaPaths = mediaPaths;
    }
    if (fallbackUrls.length > 0) {
      ctxBase.MediaUrls = fallbackUrls;
    }
    ctxBase.MediaTypes = mediaTypes;

    logger.info("Image attachments prepared", {
      decrypted: mediaPaths.length,
      fallback: fallbackUrls.length,
    });

    // For image-only messages (no text), set a placeholder body.
    if (!rawBody.trim()) {
      const count = allImageUrls.length;
      ctxBase.Body = count > 1
        ? `[用户发送了${count}张图片]`
        : "[用户发送了一张图片]";
      ctxBase.RawBody = "[图片]";
      ctxBase.CommandBody = "";
    }
  }

  // Handle file attachment.
  if (fileUrl) {
    try {
      const { localPath: localFilePath, effectiveFileName } = await downloadWecomFile(
        fileUrl,
        fileName,
        account.encodingAesKey,
        account.token,
      );
      ctxBase.MediaPaths = [...(ctxBase.MediaPaths || []), localFilePath];
      ctxBase.MediaTypes = [...(ctxBase.MediaTypes || []), guessMimeType(effectiveFileName)];
      logger.info("File attachment prepared", { path: localFilePath, name: effectiveFileName });
    } catch (e) {
      logger.warn("File download failed", { error: e.message });
      // Inform the agent about the file via text.
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      if (!rawBody.trim()) {
        ctxBase.Body = `[用户发送了文件] ${label}`;
        ctxBase.RawBody = label;
        ctxBase.CommandBody = "";
      }
    }
    if (!rawBody.trim() && !ctxBase.Body) {
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      ctxBase.Body = `[用户发送了文件] ${label}`;
      ctxBase.RawBody = label;
      ctxBase.CommandBody = "";
    }
  }

  const ctxPayload = core.reply.finalizeInboundContext(ctxBase);

  // Record session meta
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("WeCom: failed updating session meta", { error: err.message });
    });

  const runDispatch = async () => {
    // Dispatch reply with AI processing.
    // Wrap in streamContext so outbound adapters resolve the correct stream.
    await streamContext.run({ streamId, streamKey }, async () => {
      await core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        // Force block streaming for WeCom so incremental content can be emitted
        // during long LLM runs instead of waiting for final completion.
        replyOptions: {
          disableBlockStreaming: false,
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            logger.info("Dispatcher deliver called", {
              kind: info.kind,
              hasText: !!(payload.text && payload.text.trim()),
              textPreview: (payload.text || "").substring(0, 50),
            });

            await deliverWecomReply({
              payload,
              senderId: streamKey,
              streamId,
            });

            // Mark stream meta when main response is done.
            // Actual stream finish is deferred to stream refresh handler,
            // which is driven by WeCom client polling.
            if (streamId && info.kind === "final") {
              streamMeta.set(streamId, {
                mainResponseDone: true,
                doneAt: Date.now(),
              });
              logger.info("WeCom main response complete, keeping stream open for late messages", { streamId });

              // When Agent API is configured, late messages can be delivered
              // via the Agent channel — no need to keep the stream open long.
              const agentConfig = resolveAgentConfig();
              if (agentConfig) {
                setTimeout(async () => {
                  const s = streamManager.getStream(streamId);
                  if (s && !s.finished) {
                    logger.info("WeCom: closing stream early (Agent API available for late messages)", { streamId });
                    try {
                      await streamManager.finishStream(streamId);
                    } catch (err) {
                      logger.error("WeCom: failed to close stream early", { streamId, error: err.message });
                    }
                  }
                }, 3000);
              }
            }
          },
          onError: async (err, info) => {
            logger.error("WeCom reply failed", { error: err.message, kind: info.kind });
            await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
          },
        },
      });
    });

    // Safety net: ensure stream finishes after dispatch.
    // Note: Stream closing is now handled by stream refresh handler via WeCom polling.
    // This safety net only cleans up if refresh handler never fires (edge case).
    if (streamId) {
      const stream = streamManager.getStream(streamId);
      if (!stream || stream.finished) {
        unregisterActiveStream(streamKey, streamId);
      } else {
        // Stream is still open; refresh handler will close it when idle.
        // Add a safety timeout to prevent leaks if refresh never fires.
        setTimeout(async () => {
          const checkStream = streamManager.getStream(streamId);
          if (checkStream && !checkStream.finished) {
            const idleMs = Date.now() - checkStream.updatedAt;
            // Extreme fallback only: refresh handler should normally close earlier.
            if (idleMs > SAFETY_NET_IDLE_CLOSE_MS) {
              logger.warn("WeCom safety net: closing idle stream", { streamId, idleMs });
              try {
                await streamManager.finishStream(streamId);
                unregisterActiveStream(streamKey, streamId);
              } catch (err) {
                logger.error("WeCom safety net: failed to close stream", {
                  streamId,
                  error: err.message,
                });
              }
            }
          }
        }, 35000); // 35s total timeout
      }
    }
  };

  if (highPriorityCommand) {
    logger.info("WeCom: high-priority command bypassing dispatch queue", {
      streamKey,
      streamId,
      command: commandCheck.command,
    });
    try {
      await runDispatch();
    } catch (err) {
      logger.error("WeCom dispatch chain error", { streamId, streamKey, error: err.message });
      await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
    }
    return;
  }

  // Serialize non-priority dispatches per user/group.
  const prevLock = dispatchLocks.get(streamKey) ?? Promise.resolve();
  const currentDispatch = prevLock.then(runDispatch).catch(async (err) => {
    logger.error("WeCom dispatch chain error", { streamId, streamKey, error: err.message });
    await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
  });

  dispatchLocks.set(streamKey, currentDispatch);
  await currentDispatch;
  if (dispatchLocks.get(streamKey) === currentDispatch) {
    dispatchLocks.delete(streamKey);
  }
}
