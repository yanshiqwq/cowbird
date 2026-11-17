// WorkBuddy 的平台常量。内核不认识这些值 —— 它们以前长在 lib/config.js 里，
// 结果是"加一个平台就得改内核"。搬到这里之后，换平台/换域名只动这一个文件。
const ORIGIN = 'https://www.workbuddy.cn';
const LOGIN_URL = ORIGIN + '/login/?platform=agents';   // platform=admin 是企业控制台，个人号报"没有企业"
const AGENTS_URL = ORIGIN + '/agents/';

// 建会话时用的默认模型（也可以用 cowbird create --model 覆盖）
const DEFAULT_MODEL = require('../../config').envVal('COWBIRD_MODEL', 'deepseek-v4.1-flash');

module.exports = { ORIGIN, LOGIN_URL, AGENTS_URL, DEFAULT_MODEL };
