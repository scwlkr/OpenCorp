import React from 'react';
import type { Artifact } from '../core/types.js';

function remoteLink(value: string | undefined) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function artifactContentHref(artifact: Artifact) {
  const content = `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`;
  return artifact.kind === 'commit' || Object.hasOwn(artifact, 'sourcePullRequest') || Object.hasOwn(artifact, 'reviewWorkspace') ? content : remoteLink(artifact.uri) || content;
}
export function ArtifactLink({ artifact, importer }: { artifact: Artifact; importer: React.ReactNode }) {
  const imported = Object.hasOwn(artifact, 'sourcePullRequest') || Object.hasOwn(artifact, 'reviewWorkspace');
  const source = artifact.sourcePullRequest;
  const sourceUrl = remoteLink(source?.url);
  return <>
    <a className="artifact-link" href={artifactContentHref(artifact)} target="_blank" rel="noreferrer">{artifact.summary || artifact.kind || 'Open artifact'} <span aria-hidden="true">↗</span><small>{artifact.uri} · {artifact.identity}</small></a>
    {imported && <div className="artifact-provenance"><p><strong>External pull request{source?.number ? ` #${source.number}` : ''}</strong> · PR author: {source?.authorLogin || 'Not recorded'}</p><p>Imported by {importer}. The source code retains its external authorship.</p>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">Open source pull request ↗</a>}</div>}
  </>;
}
