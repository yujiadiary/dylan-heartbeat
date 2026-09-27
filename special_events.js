// 批注 2026-08-10：特殊事件必须从“带时间戳的事件消息开头”识别；
// 普通回答即使讨论了推送、Bark 或自动唤醒，也不能被截成真实事件反复注入。
// 批注 2026-09-27：新增「网页对话」事件（webchat）——webchat-server.js 会把网页端的
// 用户消息与 AI 回复写成 （时间 网页对话｜说话人：内容） 格式写入时间线。
// 以特殊事件身份存活的好处：Gateway 重建时间线时不会丢弃它们，
// Kelivo 里的对话与自动唤醒都能看到网页上聊过的内容。
const SPECIAL_EVENT_PREFIX = /^\s*[（(]\s*\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}(?::\d{2})?\s+(?:自动唤醒：本次未发送(?:\s*(?:Bark|推送))?|刚刚发送了推送|刚刚给(?:宝宝|用户)发了\s*(?:Bark|ntfy)?\s*推送|刚刚给(?:宝宝|用户)发了\s*Bark|网页对话)(?:[：:｜|）)]|\s|$)/i;

function isSpecialEventContent(content) {
  return SPECIAL_EVENT_PREFIX.test(String(content || ""));
}

module.exports = { isSpecialEventContent, SPECIAL_EVENT_PREFIX };
