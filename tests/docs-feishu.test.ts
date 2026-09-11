import assert from 'node:assert/strict';
import test from 'node:test';
import { blocksToMarkdown, type FeishuBlock } from '../src/lib/docs-feishu';

const text = (content: string) => ({ elements: [{ text_run: { content } }] });
const page = (children: string[]): FeishuBlock => ({ block_id: 'page', block_type: 1, children });

test('blocksToMarkdown shifts Feishu heading levels and drops empty heading blocks', () => {
  const markdown = blocksToMarkdown([
    page(['e1', 'h1', 'h2']),
    { block_id: 'e1', block_type: 3, heading1: { elements: [] } },
    { block_id: 'h1', block_type: 3, heading1: text('章节') },
    { block_id: 'h2', block_type: 4, heading2: text('小节') },
  ]);
  assert.equal(markdown, '## 章节\n\n### 小节');
});

test('blocksToMarkdown numbers ordered lists per level instead of flattening to bullets', () => {
  const markdown = blocksToMarkdown([
    page(['p1', 'o1', 'o2', 'o3']),
    { block_id: 'p1', block_type: 2, text: text('配置步骤') },
    { block_id: 'o1', block_type: 13, ordered: text('购买卡密') },
    { block_id: 'o2', block_type: 13, ordered: text('兑换卡密') },
    { block_id: 'o3', block_type: 13, ordered: text('创建 apikey') },
  ]);
  assert.equal(markdown, '配置步骤\n\n1. 购买卡密\n\n2. 兑换卡密\n\n3. 创建 apikey');
});

test('blocksToMarkdown nests list items through children and restarts deeper counters', () => {
  const markdown = blocksToMarkdown([
    page(['o1', 'o2']),
    { block_id: 'o1', block_type: 13, ordered: text('父项'), children: ['c1', 'c2'] },
    { block_id: 'c1', block_type: 12, bullet: text('子项一') },
    { block_id: 'c2', block_type: 12, bullet: text('子项二') },
    { block_id: 'o2', block_type: 13, ordered: text('第二项') },
  ]);
  assert.equal(markdown, '1. 父项\n  - 子项一\n  - 子项二\n\n2. 第二项');
});

test('blocksToMarkdown renders tables from cell blocks without duplicating cell text', () => {
  const markdown = blocksToMarkdown([
    page(['t1']),
    { block_id: 't1', block_type: 31, table: { property: { row_size: 2, column_size: 2 }, cells: ['c1', 'c2', 'c3', 'c4'] } },
    { block_id: 'c1', block_type: 32, text: text('模型') },
    { block_id: 'c2', block_type: 32, text: text('价格') },
    { block_id: 'c3', block_type: 32, text: text('gpt-5.5') },
    { block_id: 'c4', block_type: 32, text: text('1.5') },
  ]);
  assert.equal(markdown, '| 模型 | 价格 |\n| --- | --- |\n| gpt-5.5 | 1.5 |');
});

test('blocksToMarkdown covers code, quote, todo, divider and image blocks', () => {
  const markdown = blocksToMarkdown([
    page(['c1', 'q1', 'd1', 't1', 'i1']),
    { block_id: 'c1', block_type: 14, code: { elements: [{ text_run: { content: 'const a = 1;' } }], style: { language: 'js' } } },
    { block_id: 'q1', block_type: 15, quote: text('注意：不要一次生成多张') },
    { block_id: 'd1', block_type: 22 },
    { block_id: 't1', block_type: 17, todo: { elements: [{ text_run: { content: '安装 ccswitch' } }], style: { done: true } } },
    { block_id: 'i1', block_type: 27, image: { token: 'img-token' } },
  ]);
  assert.equal(markdown, [
    '```js\nconst a = 1;\n```',
    '> 注意：不要一次生成多张',
    '---',
    '- [x] 安装 ccswitch',
    '![飞书图片](@@FEISHU_ASSET:img-token@@)',
  ].join('\n\n'));
});

test('blocksToMarkdown keeps rich-text links and falls back to flat order without a page root', () => {
  const markdown = blocksToMarkdown([
    { block_id: 'h', block_type: 3, heading1: text('标题') },
    { block_id: 'p', block_type: 2, text: { elements: [{ text_run: { content: '查看文档', text_element_style: { link: { url: 'https://example.feishu.cn/docx/x' } } } }] } },
  ]);
  assert.equal(markdown, '## 标题\n\n[查看文档](https://example.feishu.cn/docx/x)');
});

test('blocksToMarkdown maps Feishu text run styling onto markdown emphasis', () => {
  const styled = (content: string, style: Record<string, unknown>) => ({ elements: [{ text_run: { content, text_element_style: style } }] });
  const markdown = blocksToMarkdown([
    page(['p1']),
    { block_id: 'p1', block_type: 2, text: { elements: [
      { text_run: { content: '注意 ', text_element_style: { bold: true } } },
      { text_run: { content: '不要一次生成多张', text_element_style: { italic: true } } },
      { text_run: { content: ' 用 ' } },
      { text_run: { content: 'npm run build', text_element_style: { inline_code: true } } },
    ] } },
  ]);
  assert.equal(markdown, '**注意** *不要一次生成多张* 用 `npm run build`');
  assert.equal(blocksToMarkdown([page(['p2']), { block_id: 'p2', block_type: 2, text: styled('已废弃', { strikethrough: true }) }]), '~~已废弃~~');
});

test('blocksToMarkdown ignores blocks that are not reachable from the page root', () => {
  const markdown = blocksToMarkdown([
    page(['a']),
    { block_id: 'a', block_type: 2, text: text('可见') },
    { block_id: 'orphan', block_type: 2, text: text('不可见') },
  ]);
  assert.equal(markdown, '可见');
});

test('blocksToMarkdown renders file attachments as download placeholders', () => {
  const markdown = blocksToMarkdown([
    page(['f1', 'f2']),
    { block_id: 'f1', block_type: 23, file: { token: 'file-token', name: 'CC-Switch v3.20.1 (Windows).msi' } },
    { block_id: 'f2', block_type: 23, file: { token: 'cjk-token', name: '安装包 v2.zip' } },
  ]);
  assert.equal(markdown, [
    '[CC-Switch v3.20.1 (Windows).msi](@@FEISHU_FILE:file-token:CC-Switch-v3.20.1-Windows.msi@@)',
    '[安装包 v2.zip](@@FEISHU_FILE:cjk-token:安装包-v2.zip@@)',
  ].join('\n\n'));
});

test('blocksToMarkdown keeps a file name when the attachment token is unusable', () => {
  const markdown = blocksToMarkdown([
    page(['f1']),
    { block_id: 'f1', block_type: 23, file: { name: '无 token 的附件.pdf' } },
  ]);
  assert.equal(markdown, '无 token 的附件.pdf');
});

test('blocksToMarkdown keeps inline referenced documents as links', () => {
  const markdown = blocksToMarkdown([
    page(['p1', 'p2', 'p3']),
    { block_id: 'p1', block_type: 2, text: { elements: [
      { text_run: { content: '参考：' } },
      { mention_doc: { token: 'doc-token', title: 'Claude code配置', url: 'https://example.feishu.cn/docx/doc-token' } },
    ] } },
    { block_id: 'p2', block_type: 2, text: { elements: [
      { text_run: { content: '另一篇：' } },
      { text_run: { content: '模型选型', text_element_style: { mention_doc: { token: 't2', title: '模型选型', url: 'https://example.feishu.cn/docx/t2' } } } },
    ] } },
    { block_id: 'p3', block_type: 2, text: { elements: [
      { mention_doc: { token: 't3', title: '无链接引用' } },
    ] } },
  ]);
  assert.equal(markdown, [
    '参考：[Claude code配置](https://example.feishu.cn/docx/doc-token)',
    '另一篇：[模型选型](https://example.feishu.cn/docx/t2)',
    '无链接引用',
  ].join('\n\n'));
});
