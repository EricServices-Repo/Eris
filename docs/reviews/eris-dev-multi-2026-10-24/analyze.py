#!/usr/bin/env python3
"""Offline export accounting. Signals are review candidates, never answer grades."""
import collections, hashlib, json, math, pathlib, statistics, sys
source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/Users/ericembling/Desktop/eris-dev-requests-multi.jsonl')
out = pathlib.Path(__file__).resolve().parent
raw = source.read_bytes()
header, *rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
def count(fn): return dict(collections.Counter(fn(r) for r in rows))
def dist(values):
    values = sorted(values)
    return dict(total=sum(values), median=statistics.median(values), p95NearestRank=values[math.ceil(len(values)*.95)-1], maximum=max(values))
signals = {
 'oddMarkdownFenceCount': [r['index'] for r in rows if (r.get('response') or '').count('```') % 2],
 'apologyPrefix': [r['index'] for r in rows if (r.get('response') or '').startswith("I'm sorry")],
 'protocolOrToolDiscussion': [r['index'] for r in rows if 'ASSISTANT:' in (r.get('response') or '') or 'tool call' in (r.get('response') or '').lower()],
 'offeredWorkspaceTools': [r['index'] for r in rows if any(c['tools'] for c in r['requests'])],
 'moreThanTwoCalls': [r['index'] for r in rows if r['calls'] > 2],
 'requestFindings': [r['index'] for r in rows if r['findingIds']],
}
metrics = {
 'source': str(source), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
 'records': len(rows), 'corpusTotal': header['corpus']['total'], 'exportedCoveragePercent': len(rows)/header['corpus']['total']*100,
 'uniqueQuestionIds': len({r['questionId'] for r in rows}), 'uniqueQuestions': len({r['question'] for r in rows}),
 'indices': [r['index'] for r in rows], 'header': header,
 'completion': count(lambda r:r['completion']['status']), 'inference': count(lambda r:r['stages']['inference']),
 'intent':count(lambda r:r['intent']), 'artifact':count(lambda r:r['artifact']),
 'scope':count(lambda r:r['task']['scope']['applicability']),
 'callsHistogram':count(lambda r:r['calls']), 'calls':sum(r['calls'] for r in rows),
 'callPurposes':dict(collections.Counter(c['purpose'] for r in rows for c in r['requests'])),
 'durationMs':dist([r['durationMs'] for r in rows]), 'resolveMs':dist([r['phases']['resolveMs'] for r in rows]),
 'timeToFirstAgentChunkMs':dist([r['inference']['firstTokenMs'] for r in rows if r['inference']['firstTokenMs'] is not None]),
 'findingIds':dict(collections.Counter(x for r in rows for x in r['findingIds'])), 'signals':signals,
 'warning':'Completion is transport/runtime completion, not semantic correctness. Signal counts overlap and are not failure-rate estimates.'
}
(out/'metrics.json').write_text(json.dumps(metrics, indent=2)+'\n')
with (out/'evidence.jsonl').open('w') as f:
 for r in rows:
  e={k:r.get(k) for k in ['index','questionId','sourceLine','question','intent','artifact','completion','durationMs','calls','response','findingsDetail','events','inference']}
  e['scope']=r['task']['scope'];e['obligations']=r['routeDecision']['interpretation']['obligations']
  e['signals']=[k for k,v in signals.items() if r['index'] in v]
  e['callsDetail']=[{'ordinal':i,'purpose':c['purpose'],'durationMs':c.get('durationMs'),'error':c.get('error'),'responseChars':len(c.get('response') or ''),'tools':len(c['tools']),'taskContractMarker':any('TASK CONTRACT' in str(m.get('content')) for m in c['messages'] if m.get('role')=='system')} for i,c in enumerate(r['requests'])]
  f.write(json.dumps(e)+'\n')
print(json.dumps({k:metrics[k] for k in ['sha256','bytes','records','completion','durationMs','signals']},indent=2))
