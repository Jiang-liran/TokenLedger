import React, { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { CopyButton } from './ui';
import { useAppStore } from '../store';

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return '';
}

function languageOf(node: ReactNode): string {
  if (!React.isValidElement(node)) return 'text';
  const props = node.props as { className?: string };
  const match = /language-([\w+-]+)/.exec(props.className ?? '');
  return match?.[1] ?? 'text';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = extractText(children);
  return (
    <div className="code-shell">
      <div className="code-head">
        <span>{languageOf(children)}</span>
        <CopyButton text={code} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <code className={className}>{children}</code>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && href.startsWith('https://')) {
          void useAppStore.getState().openExternal(href);
        } else {
          useAppStore.getState().pushToast('info', '仅支持打开 HTTPS 链接。');
        }
      }}
      title={href}
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto' }}>
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span className="hint">［图片：{alt || '无描述'}（外部图片已被安全策略阻止）］</span>,
};

function MarkdownImpl({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
