#!/usr/bin/env node
/**
 * 题库校验脚本
 *
 * 用法：node scripts/check-bank.js
 *
 * 校验三件事：
 *   1. 编译 interview-trainer.html 里的 <script>，抓语法错误。
 *      （历史上真实踩过的坑：答案正文里出现裸反引号，提前终止了模板字符串，页面直接白屏）
 *   2. 解析 BANK 数组，校验字段完整性、分类与难度合法性、题干唯一性。
 *   3. 校验 tags（考点标签）与 fu（面试官追问）的结构，
 *      包括标签非空去重、追问含问题与要点、标签大小写一致性。
 *   4. 校验答案与追问要点里的 HTML 标签是否成对闭合。
 *
 * 有错误时退出码为 1，可直接用于 CI。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 可选参数：指定要校验的文件，默认校验仓库根目录的主程序。
// 传入路径的用途之一是验证校验器本身是否真的能拦住错误写法。
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'interview-trainer.html'));

// 校验答案与追问要点时纳入配对检查的标签。
// 不含 br / img 这类自闭合标签；i 的匹配用 "<i" 加空格或右尖括号，不会误伤 <li> 与 <img>。
const HTML_TAGS = ['p', 'div', 'ul', 'ol', 'li', 'pre', 'code', 'span', 'b', 'strong', 'em', 'i'];
const countOpen = (html, tag) => (html.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
const countClose = (html, tag) => (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;

const errors = [];
const warnings = [];
const fail = msg => errors.push(msg);
const warn = msg => warnings.push(msg);

if (!fs.existsSync(FILE)) {
  console.error('找不到文件：' + FILE);
  process.exit(1);
}
const html = fs.readFileSync(FILE, 'utf8');

/* ---------------- 1. 整段脚本的语法检查 ---------------- */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length === 0) fail('HTML 中没有找到 <script> 代码块');

const code = blocks.join('\n;\n');
if (blocks.length > 0) {
  try {
    new Function(code);
  } catch (e) {
    fail('JS 语法错误：' + e.message);
  }
}

/* ---------------- 2. 解析题库与配置 ---------------- */
function sliceBetween(text, openTag, closeTag) {
  const s = text.indexOf(openTag);
  if (s < 0) return null;
  const e = text.indexOf(closeTag, s + openTag.length);
  if (e < 0) return null;
  return text.slice(s + openTag.length, e);
}

function evalLiteral(pattern, label) {
  const m = code.match(pattern);
  if (!m) {
    fail('未能解析 ' + label + '，可能被改名或改动了写法');
    return null;
  }
  try {
    return new Function('return ' + m[1])();
  } catch (e) {
    fail(label + ' 无法解析：' + e.message);
    return null;
  }
}

const CATS = evalLiteral(/const CATS = (\{[\s\S]*?\n\});/, 'CATS 分类表');
const LVS = evalLiteral(/const LVS = (\[[^\]]*\]);/, 'LVS 难度表');

const bankText = sliceBetween(code, 'const BANK = [', '\n];');
let BANK = null;
if (bankText === null) {
  fail('未能定位 const BANK = [ ... ]; 数组');
} else {
  try {
    BANK = new Function('return [' + bankText + ']')();
  } catch (e) {
    fail('题库数组无法解析：' + e.message);
  }
}

if (!code.includes('const keyOf')) {
  warn('脚本中未找到 keyOf，请确认持久化键仍是"分类 + 题干"的稳定键');
}

/* ---------------- 3. 逐条校验 ---------------- */
const FIELDS = [
  ['c', '分类'],
  ['lv', '难度'],
  ['q', '题干'],
  ['h', '提示'],
  ['a', '答案'],
];

if (Array.isArray(BANK)) {
  const stemIndex = new Map();

  BANK.forEach((item, i) => {
    const at = '第 ' + (i + 1) + ' 条';
    const brief = item && typeof item.q === 'string' ? item.q.slice(0, 18) + '…' : '(无题干)';

    if (!item || typeof item !== 'object') {
      fail(at + '：不是一个对象');
      return;
    }

    FIELDS.forEach(([key, label]) => {
      const v = item[key];
      if (typeof v !== 'string' || v.trim() === '') {
        fail(at + '（' + brief + '）：' + label + ' 字段缺失或为空');
      }
    });

    if (CATS && item.c && !CATS[item.c]) {
      fail(at + '：分类 "' + item.c + '" 不在 CATS 中，合法值：' + Object.keys(CATS).join(' / '));
    }
    if (LVS && item.lv && !LVS.includes(item.lv)) {
      fail(at + '：难度 "' + item.lv + '" 不在 LVS 中，合法值：' + LVS.join(' / '));
    }

    if (typeof item.q === 'string' && item.q.trim() !== '') {
      if (stemIndex.has(item.q)) {
        fail('题干重复：' + at + ' 与第 ' + stemIndex.get(item.q) + ' 条相同 —— 题干是收藏与进度的稳定键，必须全局唯一');
      } else {
        stemIndex.set(item.q, i + 1);
      }
    }

    if (typeof item.h === 'string' && item.h.length > 160) {
      warn(at + '：提示 ' + item.h.length + ' 字，偏长，提示只给方向更好');
    }
    if (typeof item.a === 'string' && item.a.length < 150) {
      warn(at + '：答案仅 ' + item.a.length + ' 字，确认内容是否完整');
    }

    /* tags：考点标签，用于检索。必须是非空字符串数组且不重复。 */
    if (!Array.isArray(item.tags)) {
      fail(at + '（' + brief + '）：tags 字段缺失或不是数组');
    } else if (item.tags.length === 0) {
      fail(at + '（' + brief + '）：tags 是空数组，至少写 1 个考点标签');
    } else {
      const seenTag = new Set();
      item.tags.forEach(t => {
        if (typeof t !== 'string' || t.trim() === '') {
          fail(at + '（' + brief + '）：tags 中存在空标签');
        } else if (seenTag.has(t)) {
          fail(at + '（' + brief + '）：标签重复 "' + t + '"');
        } else {
          seenTag.add(t);
        }
      });
    }

    /* fu：面试官追问，每项为 { q: 问题, a: 要点 } */
    if (!Array.isArray(item.fu)) {
      fail(at + '（' + brief + '）：fu 字段缺失或不是数组');
    } else if (item.fu.length === 0) {
      fail(at + '（' + brief + '）：fu 是空数组，至少写 1 条追问');
    } else {
      item.fu.forEach((p, j) => {
        const where = at + '（' + brief + '）第 ' + (j + 1) + ' 条追问';
        if (!p || typeof p !== 'object') {
          fail(where + '：不是一个对象');
          return;
        }
        if (typeof p.q !== 'string' || p.q.trim() === '') fail(where + '：缺少问题字段 q');
        if (typeof p.a !== 'string' || p.a.trim() === '') {
          fail(where + '：缺少要点字段 a');
        } else if (p.a.length < 30) {
          warn(where + '：要点仅 ' + p.a.length + ' 字，可能过于简略');
        }
      });
      if (item.fu.length < 2) warn(at + '（' + brief + '）：只有 ' + item.fu.length + ' 条追问，建议每题至少 2 条');
      if (item.fu.length > 5) warn(at + '（' + brief + '）：有 ' + item.fu.length + ' 条追问，偏多，建议精炼');
    }

    /* 答案与追问要点里的 HTML 标签必须成对，否则渲染出来的结构会错乱 */
    const checkHtml = (html, where) => {
      HTML_TAGS.forEach(tag => {
        const o = countOpen(html, tag), c = countClose(html, tag);
        if (o !== c) fail(where + '：<' + tag + '> 开闭不匹配（开 ' + o + ' / 闭 ' + c + '）');
      });
    };
    if (typeof item.a === 'string') checkHtml(item.a, at + '（' + brief + '）答案');
    if (Array.isArray(item.fu)) {
      item.fu.forEach((p, j) => {
        if (p && typeof p.a === 'string') checkHtml(p.a, at + '（' + brief + '）第 ' + (j + 1) + ' 条追问要点');
      });
    }
  });
} else if (bankText !== null) {
  fail('题库不是数组');
}

/* ---------------- 4. 报告 ---------------- */
const SEP = '-'.repeat(56);
console.log(SEP);
console.log('题库校验报告');
console.log(SEP);

if (Array.isArray(BANK)) {
  const byCat = {};
  const byLv = {};
  BANK.forEach(q => {
    if (!q) return;
    byCat[q.c] = (byCat[q.c] || 0) + 1;
    byLv[q.lv] = (byLv[q.lv] || 0) + 1;
  });
  const stems = BANK.filter(q => q && typeof q.q === 'string').map(q => q.q);
  const rawTags = BANK.flatMap(q => (Array.isArray(q.tags) ? q.tags : []));
  const tagSet = new Set(rawTags);
  const fuTotal = BANK.reduce((s, q) => s + (Array.isArray(q.fu) ? q.fu.length : 0), 0);
  const noTag = BANK.filter(q => !Array.isArray(q.tags) || !q.tags.length).length;

  // 标签大小写不一致会造成检索时"看着是同一个考点却分成了两个"
  const lowerMap = new Map();
  tagSet.forEach(t => {
    const k = String(t).toLowerCase();
    if (lowerMap.has(k) && lowerMap.get(k) !== t) {
      warn('标签大小写不一致："' + lowerMap.get(k) + '" 与 "' + t + '"');
    } else {
      lowerMap.set(k, t);
    }
  });

  console.log('题目总数  ' + BANK.length);
  console.log('题干唯一  ' + new Set(stems).size + ' / ' + stems.length);
  console.log('分类分布  ' + Object.entries(byCat).map(([k, v]) => k + '=' + v).join('  '));
  console.log('难度分布  ' + Object.entries(byLv).map(([k, v]) => k + '=' + v).join('  '));
  console.log('追问总数  ' + fuTotal + '（平均每题 ' + (BANK.length ? (fuTotal / BANK.length).toFixed(1) : 0) + ' 条）');
  console.log('考点标签  ' + tagSet.size + ' 个去重' + (noTag ? '，' + noTag + ' 题没有标签' : ''));
  console.log(SEP);
}

warnings.forEach(w => console.log('[WARN] ' + w));
errors.forEach(e => console.log('[FAIL] ' + e));

if (errors.length > 0) {
  console.log(SEP);
  console.log('校验未通过：' + errors.length + ' 个错误，' + warnings.length + ' 个警告');
  process.exit(1);
}

console.log(SEP);
console.log('校验通过：' + (Array.isArray(BANK) ? BANK.length : 0) + ' 题，' + warnings.length + ' 个警告');
