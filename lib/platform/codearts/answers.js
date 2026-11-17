// 提问回答（messages/reply）的形状转换 —— 本平台最容易抄错的一处。
//
// 实测（见调查报告 3.4）：正确的形状是「数组的数组」，内层元素固定写成
//     `"<label>" - <description>`        ← 带双引号、空格、连字符、再空格
// 例：{ question_id: 'que_…', answers: [ [ '"苹果" - 清脆多汁，香甜可口' ] ] }
// 抄成 [{answer:'苹果'}] / ['苹果'] 一律 400 CODEBASE.00011002.400，且报错只说"参数无效"，
// 排查成本极高。所以这一层单列出来，并有离线自测兜着。
//
// 外层数组的每一项对应 questions[] 里的一题（顺序敏感）；内层是该题被选中的选项
// （多选题就有多项）。

/** 选项 → 内层元素。description 缺失时补空串，保持"固定格式"不变形。 */
function formatChoice(label, description) {
  const l = label === undefined || label === null ? '' : String(label);
  const d = description === undefined || description === null ? '' : String(description);
  return `"${l}" - ${d}`;
}

/** 已经是 `"…" - …` 形状的字符串就别再套一层引号 */
function looksFormatted(s) {
  const t = String(s);
  return /^".*"\s+-\s?/.test(t);
}

/** 把题目里的选项按 label/value 查出来（用户只传 label 时用它补 description） */
function findOption(questions, qi, label) {
  const q = (questions || [])[qi];
  const opts = (q && q.options) || [];
  const hit = opts.find((o) => String(o && (o.label !== undefined ? o.label : o.value)) === String(label));
  return hit || null;
}

/**
 * 单个答案 → 内层元素。
 * 接受：已格式化字符串 / 选项 label / {label,description} / {text} / {value} / {raw}
 */
function toChoice(x, questions, qi) {
  if (x === undefined || x === null) return null;
  if (typeof x === 'string') {
    if (looksFormatted(x)) return x.trim();
    const opt = findOption(questions, qi, x);
    return formatChoice(x, opt ? opt.description : '');
  }
  if (typeof x === 'object') {
    if (x.raw !== undefined) return String(x.raw);
    if (x.label !== undefined) return formatChoice(x.label, x.description);
    if (x.text !== undefined) return formatChoice(x.text, x.description);
    if (x.value !== undefined) return formatChoice(x.value, x.description);
    // 直接扔了个题库里的 option 对象（带 label+description）走上面那条
  }
  return formatChoice(x, '');
}

/**
 * 任意输入 → `[["…"],["…"]]`。
 *
 * 支持的输入形态（都对同一份 questions 生效）：
 *   [["\"苹果\" - 清脆多汁"]]        已经拼好的，逐项规范化
 *   [{label:'苹果',description:'…'}] 一题一答
 *   ['苹果','香蕉']                  单题多选（questions 只有 0/1 题时按同题多选处理）
 *   '苹果'                           单题单答
 * 返回里空分组会被保留（外层长度必须对齐题数，不能因为某题没答就少一项……
 * 但这个平台按题序取，所以确实没答的题只能传空数组，交由调用方判断）。
 */
function buildAnswers(input, questions = []) {
  const qs = Array.isArray(questions) ? questions : [];

  // 已经是「数组的数组」
  if (Array.isArray(input) && input.length && input.every((x) => Array.isArray(x))) {
    return input.map((group, qi) => group.map((x) => toChoice(x, qs, qi)).filter((s) => s !== null && s !== ''));
  }

  // 一题一答 / 单题多选
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (qs.length <= 1) {
      return [input.map((x) => toChoice(x, qs, 0)).filter((s) => s !== null && s !== '')];
    }
    return input.map((x, qi) => {
      const c = toChoice(x, qs, qi);
      return c === null || c === '' ? [] : [c];
    });
  }

  if (input === undefined || input === null || input === '') return [];
  const one = toChoice(input, qs, 0);
  return one === null || one === '' ? [] : [[one]];
}

/** 给人看的一行摘要（日志/调试用） */
function describeAnswers(answers) {
  if (!Array.isArray(answers)) return '(空)';
  return answers.map((g, i) => `#${i + 1}[${(g || []).join(' | ')}]`).join(' ');
}

module.exports = { formatChoice, looksFormatted, toChoice, buildAnswers, describeAnswers };
