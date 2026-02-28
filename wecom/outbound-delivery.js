import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { agentSendText } from "./agent-api.js";
import { parseResponseUrlResult } from "./response-url.js";
import { resolveAgentConfig, responseUrls, streamContext } from "./state.js";
import { resolveActiveStream } from "./stream-utils.js";
import { THINKING_PLACEHOLDER } from "./constants.js";

export async function deliverWecomReply({ payload, senderId, streamId }) {
  const text = payload.text || "";

  logger.debug("deliverWecomReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
  });

  // Handle absolute-path MEDIA lines manually; OpenClaw rejects these paths upstream.
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  const mediaMatches = [];
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const mediaPath = match[1].trim();
    // Only intercept absolute filesystem paths.
    if (mediaPath.startsWith("/")) {
      mediaMatches.push({
        fullMatch: match[0],
        path: mediaPath,
      });
      logger.debug("Detected absolute path MEDIA line", {
        streamId,
        mediaPath,
        line: match[0],
      });
    }
  }

  // Queue absolute-path images and remove corresponding MEDIA lines from text.
  let processedText = text;
  if (mediaMatches.length > 0 && streamId) {
    for (const media of mediaMatches) {
      const queued = streamManager.queueImage(streamId, media.path);
      if (queued) {
        // Remove this MEDIA line once image was queued.
        processedText = processedText.replace(media.fullMatch, "").trim();
        logger.info("Queued absolute path image for stream", {
          streamId,
          imagePath: media.path,
        });
      }
    }
  }

  // All outbound content is sent via stream updates.
  if (!processedText.trim()) {
    logger.debug("WeCom: empty block after processing, skipping stream update");
    return;
  }

  // Helper: append content with duplicate suppression and placeholder awareness.
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) {
      return false;
    }

    // If stream still has the placeholder, replace it entirely.
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(targetStreamId, content, THINKING_PLACEHOLDER);
      return true;
    }

    // Skip duplicate chunks (for example, block + final overlap).
    if (stream.content.includes(content.trim())) {
      logger.debug("WeCom: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: content.substring(0, 30),
      });
      return true;
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // Try async context first, then fallback to active stream map.
    const ctx = streamContext.getStore();
    const contextStreamId = ctx?.streamId;
    const activeStreamId = contextStreamId ?? resolveActiveStream(senderId);

    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, processedText);
      logger.debug("WeCom stream appended (via context/activeStreams)", {
        streamId: activeStreamId,
        source: contextStreamId ? "asyncContext" : "activeStreams",
        contentLength: processedText.length,
      });
      return;
    }
    logger.warn("WeCom: no active stream for this message", { senderId });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WeCom: stream not found, attempting response_url fallback", { streamId, senderId });

    // Layer 2: Fallback via response_url (stream closed, but response_url may still be valid)
    const saved = responseUrls.get(senderId);
    if (saved && !saved.used && Date.now() < saved.expiresAt) {
      try {
        const response = await fetch(saved.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: processedText } }),
        });
        const responseBody = await response.text().catch(() => "");
        const result = parseResponseUrlResult(response, responseBody);
        if (!result.accepted) {
          logger.error("WeCom: response_url fallback rejected (deliverWecomReply)", {
            senderId,
            status: response.status,
            statusText: response.statusText,
            errcode: result.errcode,
            errmsg: result.errmsg,
            bodyPreview: result.bodyPreview,
          });
        } else {
          saved.used = true;
          logger.info("WeCom: sent via response_url fallback (deliverWecomReply)", {
            senderId,
            status: response.status,
            errcode: result.errcode,
            contentPreview: processedText.substring(0, 50),
          });
          return;
        }
      } catch (err) {
        logger.error("WeCom: response_url fallback failed", {
          senderId,
          error: err.message,
        });
      }
    }

    // Layer 3: Agent API fallback (stream closed + response_url unavailable)
    const agentConfig = resolveAgentConfig();
    if (agentConfig) {
      try {
        await agentSendText({ agent: agentConfig, toUser: senderId, text: processedText });
        logger.info("WeCom: sent via Agent API fallback (deliverWecomReply)", {
          senderId,
          contentPreview: processedText.substring(0, 50),
        });
        return;
      } catch (err) {
        logger.error("WeCom: Agent API fallback failed", { senderId, error: err.message });
      }
    }
    logger.warn("WeCom: unable to deliver message (all layers exhausted)", {
      senderId,
      contentPreview: processedText.substring(0, 50),
    });
    return;
  }

  appendToStream(streamId, processedText);
  logger.debug("WeCom stream appended", {
    streamId,
    contentLength: processedText.length,
    to: senderId,
  });
}
