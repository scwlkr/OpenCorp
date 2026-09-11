import React from 'react';
import { describeNarrative } from '../core/narratives.js';

export function Narratives({ values, empty }: { values: unknown[]; empty: string }) {
  if (!values.length) return <div className="empty">{empty}</div>;
  return <ul className="narratives">{values.map((value, index) => {
    const item = describeNarrative(value);
    return <li key={index}>{typeof value === 'string' ? value : <>
      <strong>{item.title}</strong>
      {item.rationale && <p>{item.rationale}</p>}
      {item.measure && <p>Success measure: {item.measure}</p>}
      {item.status && <span className={`badge status-${item.status.replaceAll('_', '-')}`}>{item.status.replaceAll('_', ' ')}</span>}
      <details className="record-details"><summary>Record details</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
    </>}</li>;
  })}</ul>;
}
