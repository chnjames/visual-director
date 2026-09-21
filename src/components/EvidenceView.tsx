import type { Evidence } from '../shared/types';

export function EvidenceView({ evidence }: { evidence: Evidence[] }) {
  return (
    <div className="evidence">
      {evidence.map((e, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          📎 <code>{e.sourceType}</code> <code>{e.sourceId.slice(-8)}</code>
          {e.region && (
            <>
              {' '}
              区域 x={e.region.x.toFixed(2)} y={e.region.y.toFixed(2)} w=
              {e.region.width.toFixed(2)} h={e.region.height.toFixed(2)}
            </>
          )}
          {e.quote && <span>｜{e.quote}</span>}
          ｜置信 {(e.confidence * 100).toFixed(0)}%
        </div>
      ))}
    </div>
  );
}
