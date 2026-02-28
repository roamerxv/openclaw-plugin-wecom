import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WecomCrypto } from "../crypto.js";
import { logger } from "../logger.js";
import { MEDIA_CACHE_DIR } from "./constants.js";

/**
 * Download and decrypt a WeCom encrypted image.
 * @param {string} imageUrl - Encrypted image URL from WeCom
 * @param {string} encodingAesKey - AES key
 * @param {string} token - Token
 * @returns {Promise<{ localPath: string, mimeType: string }>} Local path and mime type
 */
export async function downloadAndDecryptImage(imageUrl, encodingAesKey, token) {
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading encrypted image", { url: imageUrl.substring(0, 80) });
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const encryptedBuffer = Buffer.from(await response.arrayBuffer());
  logger.debug("Downloaded encrypted image", { size: encryptedBuffer.length });

  const wecomCrypto = new WecomCrypto(token, encodingAesKey);
  const decryptedBuffer = wecomCrypto.decryptMedia(encryptedBuffer);

  // Detect image type via magic bytes.
  let ext = "jpg";
  if (decryptedBuffer[0] === 0x89 && decryptedBuffer[1] === 0x50) {
    ext = "png";
  } else if (decryptedBuffer[0] === 0x47 && decryptedBuffer[1] === 0x49) {
    ext = "gif";
  }

  const filename = `wecom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const localPath = join(MEDIA_CACHE_DIR, filename);
  writeFileSync(localPath, decryptedBuffer);

  const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  logger.info("Image decrypted and saved", { path: localPath, size: decryptedBuffer.length, mimeType });
  return { localPath, mimeType };
}

/**
 * Download and decrypt a file from WeCom.
 * Note: WeCom encrypts ALL media files (not just images) with AES-256-CBC.
 * @param {string} fileUrl - File download URL
 * @param {string} fileName - Original file name
 * @param {string} encodingAesKey - AES key for decryption
 * @param {string} token - Token for decryption
 * @returns {Promise<{ localPath: string, effectiveFileName: string }>} Local path and resolved filename
 */
export async function downloadWecomFile(fileUrl, fileName, encodingAesKey, token) {
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading encrypted file", { url: fileUrl.substring(0, 80), name: fileName });
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const encryptedBuffer = Buffer.from(await response.arrayBuffer());

  // Try to extract filename from Content-Disposition header if not provided
  let effectiveFileName = fileName;
  if (!effectiveFileName) {
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      // Match: filename="xxx.pdf" or filename*=UTF-8''xxx.pdf
      const filenameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
      if (filenameMatch && filenameMatch[1]) {
        effectiveFileName = decodeURIComponent(filenameMatch[1]);
        logger.info("Extracted filename from Content-Disposition", { name: effectiveFileName });
      }
    }
  }

  // Decrypt the file (WeCom encrypts all media the same way as images)
  const wecomCrypto = new WecomCrypto(token, encodingAesKey);
  const decryptedBuffer = wecomCrypto.decryptMedia(encryptedBuffer);

  const safeName = (effectiveFileName || `file_${Date.now()}`).replace(/[/\\:*?"<>|]/g, "_");
  const localPath = join(MEDIA_CACHE_DIR, `${Date.now()}_${safeName}`);
  writeFileSync(localPath, decryptedBuffer);

  logger.info("File decrypted and saved", { path: localPath, size: decryptedBuffer.length });
  return { localPath, effectiveFileName: effectiveFileName || fileName };
}

/**
 * Guess MIME type from file extension.
 */
export function guessMimeType(fileName) {
  const ext = (fileName || "").split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  };
  return mimeMap[ext] || "application/octet-stream";
}
