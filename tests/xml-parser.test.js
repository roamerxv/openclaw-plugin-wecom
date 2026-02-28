import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEncryptFromXml,
  parseXml,
  extractMsgType,
  extractFromUser,
  extractChatId,
  extractContent,
  extractMediaId,
  extractMsgId,
  extractFileName,
} from "../wecom/xml-parser.js";

describe("extractEncryptFromXml", () => {
  it("extracts CDATA-wrapped Encrypt field", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[ww1234]]></ToUserName>
      <Encrypt><![CDATA[abc123encrypted]]></Encrypt>
    </xml>`;
    assert.equal(extractEncryptFromXml(xml), "abc123encrypted");
  });

  it("extracts plain Encrypt field", () => {
    const xml = `<xml><Encrypt>plainEncryptedData</Encrypt></xml>`;
    assert.equal(extractEncryptFromXml(xml), "plainEncryptedData");
  });

  it("throws on missing Encrypt field", () => {
    assert.throws(() => extractEncryptFromXml("<xml><Other>data</Other></xml>"), /missing Encrypt/);
  });
});

describe("parseXml", () => {
  const sampleXml = `<xml>
    <ToUserName><![CDATA[ww1234]]></ToUserName>
    <FromUserName><![CDATA[zhangsan]]></FromUserName>
    <CreateTime>1348831860</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[Hello world]]></Content>
    <MsgId>1234567890123456</MsgId>
    <AgentID>1000002</AgentID>
  </xml>`;

  it("parses CDATA and plain text fields", () => {
    const msg = parseXml(sampleXml);
    assert.equal(msg.ToUserName, "ww1234");
    assert.equal(msg.FromUserName, "zhangsan");
    assert.equal(msg.CreateTime, "1348831860");
    assert.equal(msg.MsgType, "text");
    assert.equal(msg.Content, "Hello world");
    assert.equal(msg.MsgId, "1234567890123456");
    assert.equal(msg.AgentID, "1000002");
  });

  it("extracts message type", () => {
    const msg = parseXml(sampleXml);
    assert.equal(extractMsgType(msg), "text");
  });

  it("extracts sender", () => {
    const msg = parseXml(sampleXml);
    assert.equal(extractFromUser(msg), "zhangsan");
  });

  it("extracts message id", () => {
    const msg = parseXml(sampleXml);
    assert.equal(extractMsgId(msg), "1234567890123456");
  });
});

describe("extractChatId", () => {
  it("returns undefined for DM (no ChatId)", () => {
    const msg = parseXml(`<xml><FromUserName><![CDATA[user1]]></FromUserName></xml>`);
    assert.equal(extractChatId(msg), undefined);
  });

  it("extracts ChatId for group messages", () => {
    const xml = `<xml>
      <FromUserName><![CDATA[user1]]></FromUserName>
      <ChatId><![CDATA[wr123456]]></ChatId>
    </xml>`;
    const msg = parseXml(xml);
    assert.equal(extractChatId(msg), "wr123456");
  });
});

describe("extractContent", () => {
  it("extracts text content", () => {
    const msg = { MsgType: "text", Content: "hello" };
    assert.equal(extractContent(msg), "hello");
  });

  it("handles voice with recognition", () => {
    const msg = { MsgType: "voice", Recognition: "你好" };
    assert.equal(extractContent(msg), "你好");
  });

  it("defaults voice without recognition", () => {
    const msg = { MsgType: "voice" };
    assert.equal(extractContent(msg), "[语音消息]");
  });

  it("handles image", () => {
    const msg = { MsgType: "image", PicUrl: "https://example.com/img.jpg" };
    assert.equal(extractContent(msg), "[图片] https://example.com/img.jpg");
  });

  it("handles file", () => {
    const msg = { MsgType: "file" };
    assert.equal(extractContent(msg), "[文件消息]");
  });

  it("handles unknown type", () => {
    const msg = { MsgType: "unknown_type" };
    assert.equal(extractContent(msg), "[unknown_type]");
  });
});

describe("extractMediaId", () => {
  it("extracts MediaId from parsed message", () => {
    const xml = `<xml><MsgType><![CDATA[image]]></MsgType><MediaId><![CDATA[media_abc123]]></MediaId></xml>`;
    const msg = parseXml(xml);
    assert.equal(extractMediaId(msg), "media_abc123");
  });

  it("returns undefined when no MediaId", () => {
    const msg = { MsgType: "text", Content: "hello" };
    assert.equal(extractMediaId(msg), undefined);
  });
});

describe("extractFileName", () => {
  it("extracts FileName from file message", () => {
    const xml = `<xml><MsgType><![CDATA[file]]></MsgType><FileName><![CDATA[report.pdf]]></FileName></xml>`;
    const msg = parseXml(xml);
    assert.equal(extractFileName(msg), "report.pdf");
  });

  it("returns undefined when no FileName", () => {
    const msg = { MsgType: "text" };
    assert.equal(extractFileName(msg), undefined);
  });
});
