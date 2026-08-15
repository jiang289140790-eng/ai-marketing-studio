import { isSafeFragment } from '../../services/harness-presentation.js';

// A visualize HTML fragment renders only inside a fully sandboxed iframe
// (sandbox="" blocks scripts, forms, popups, and same-origin access) whose
// document carries its own CSP. The fragment was already sanitized by the
// gateway contract and re-validated here before any string reaches the DOM;
// external subresources are blocked by the iframe CSP so the card cannot
// leave the page.

function frameDocument(html) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:;">',
    '<style>html,body{margin:0;background:transparent;color-scheme:dark}body{font:14px/1.65 system-ui,sans-serif;color:#e8eefc;padding:14px;box-sizing:border-box}img{max-width:100%}</style>',
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}

export function FragmentBlock({ block }) {
  if (!block || typeof block.html !== 'string' || !isSafeFragment(block.html)) {
    return (
      <figure className="harp-block harp-fallback" data-testid="presentation-block-fallback">
        <figcaption>{block?.title || '可视化'}</figcaption>
        <div className="harp-fallback-body">可视化片段无效或超出安全边界。</div>
      </figure>
    );
  }
  return (
    <figure className="harp-block harp-fragment" data-testid="presentation-block-fragment">
      <figcaption>{block.title || '可视化'}</figcaption>
      <iframe
        className="harp-fragment-frame"
        title={block.title || '可视化片段'}
        sandbox=""
        srcDoc={frameDocument(block.html)}
        loading="lazy"
      />
    </figure>
  );
}
