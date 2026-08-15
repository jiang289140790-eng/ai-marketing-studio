import { Component } from 'react';
import { ChartBlock } from './ChartBlock.jsx';
import { FlowBlock } from './FlowBlock.jsx';
import { TableBlock } from './TableBlock.jsx';
import { FragmentBlock } from './FragmentBlock.jsx';
import { FallbackBlock, SummaryBlock } from './TextBlocks.jsx';
import './harness-presentation.css';

// One boundary per block: a renderer crash (adversarial or unexpected data)
// degrades to a bounded fallback card and the remaining blocks still render.
// The panel never throws into the page.
class BlockBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <FallbackBlock block={{ title: this.props.block?.title || '内容块', text: '该内容块渲染失败，已安全降级。' }} />;
    }
    return this.props.children;
  }
}

function BlockView({ block }) {
  switch (block?.kind) {
    case 'chart':
      return <ChartBlock block={block} />;
    case 'flow':
      return <FlowBlock block={block} />;
    case 'table':
      return <TableBlock block={block} />;
    case 'fragment':
      return <FragmentBlock block={block} />;
    case 'summary':
      return <SummaryBlock block={block} />;
    case 'fallback':
      return <FallbackBlock block={block} />;
    default:
      return <FallbackBlock block={{ title: '内容块', text: '未知的内容块类型。' }} />;
  }
}

export function PresentationPanel({ blocks }) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return (
    <section className="harp-presentation" data-testid="harness-presentation" aria-label="任务结果可视化">
      {blocks.map((block, index) => (
        <BlockBoundary key={`block-${index}`} block={block}>
          <BlockView block={block} />
        </BlockBoundary>
      ))}
    </section>
  );
}
