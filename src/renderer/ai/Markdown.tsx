import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={index}>{part.slice(1, -1)}</em>;
      }
      return part;
    });
}

/** Small safe Markdown renderer: no HTML injection and enough structure for chat replies. */
export function Markdown({ children }: { children: string }) {
  const lines = children.split('\n');
  const nodes: ReactNode[] = [];
  let code: string[] | null = null;
  let list: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {list.map((item, index) => (
          <li key={index}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        nodes.push(
          <pre key={`code-${nodes.length}`}>
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem?.[1]) {
      list.push(listItem[1]);
      continue;
    }
    flushList();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading?.[2]) {
      const level = heading[1]?.length ?? 1;
      nodes.push(
        level === 1 ? (
          <h3 key={nodes.length}>{inline(heading[2])}</h3>
        ) : (
          <h4 key={nodes.length}>{inline(heading[2])}</h4>
        ),
      );
    } else if (line.trim()) {
      nodes.push(<p key={nodes.length}>{inline(line)}</p>);
    }
  }
  flushList();
  if (code) {
    nodes.push(
      <pre key={`code-${nodes.length}`}>
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }
  return <div className="ai-markdown">{nodes}</div>;
}
