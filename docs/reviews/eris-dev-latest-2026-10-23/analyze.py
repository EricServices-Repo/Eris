"""Offline v2 capture audit. Predicates identify candidates, not answer failures."""
import collections, hashlib, json, re, statistics, sys
from pathlib import Path
source=Path(sys.argv[1]); out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
counters=collections.defaultdict(collections.Counter); flags=collections.defaultdict(list); lengths=collections.defaultdict(list); rows=[]
with source.open() as f:
 header=json.loads(next(f))
 for line in f:
  r=json.loads(line);rows.append(r);t=r['task'];i=t['interpretation'];q=r['question'];a=next(x for x in r['requests'] if x['purpose']=='agent');s='\n'.join(m['content'] for m in a['messages'] if m['role']=='system'); modeltask=json.loads(s.split('\n\n')[0].split('\n',1)[1]);res=r['routeDecision']['resolution']
  for k,v in [('intent',r['intent']),('artifact',r['artifact']),('agent',r['agent']),('scope',t['scope'].get('applicability')),('resolution',res['source']),('rule',res['rule']),('stackFit',i.get('stackFit')),('status',r['status']),('tools',len(a['tools'])),('retrieval',str((r.get('retrieval') or {}).get('skipped')))]: counters[k][v]+=1
  predicates={
   'generic_requires_files':t['scope'].get('applicability')=='generic' and any('grounded in' in x and 'files' in x for x in t['acceptanceCriteria']),
   'generic_has_tools':t['scope'].get('applicability')=='generic' and bool(a['tools']),
   'scope_applicability_omitted':'applicability' not in modeltask['scope'],
   'write_happy_path_explanation':q.startswith('Can you write ') and 'happy path is obvious' in q and i['artifact']=='explanation',
   'practical_example_explanation':q.startswith('I need a practical example of ') and i['artifact']=='explanation',
   'explain_as_plan':q.startswith('Explain how to implement ') and r['intent']=='plan',
   'show_example_explore':r['intent']=='explore' and i['artifact']=='code-example',
   'design_wording_explanation':q.startswith('How should I structure the code for ') and i['artifact']=='explanation',
   'two_versions_single_obligation':'both a simple and a more robust version' in q and len(i['obligations'])==1,
   'good_coverage_missing':'with good test coverage' in q and not any(x['kind']=='tests' for x in i['obligations']),
   'tests_not_obligation':bool(re.search(r'\btests?\b|test coverage',q,re.I)) and not any(x['kind']=='tests' for x in i['obligations']),
   'generic_stack_mismatch':t['scope'].get('applicability')=='generic' and i.get('stackFit')=='mismatch',
   'concept_missing_language':'error boundaries' in q and i.get('language') is None and i.get('conceptFit') is None,
   'no_retrieval_evidence_requires_files':not (r.get('retrieval') or {}).get('results') and any('grounded in' in x and 'files' in x for x in t['acceptanceCriteria']),
  }
  for k,v in predicates.items():
   if v:flags[k].append({'index':r['index'],'questionId':r['questionId'],'question':q,'intent':r['intent'],'artifact':i['artifact'],'obligations':i['obligations']})
  for k,v in [('systemChars',len(s)),('toolSchemaChars',len(json.dumps(a['tools'],separators=(',',':')))),('durationMs',r['durationMs'])]:lengths[k].append(v)
  counters['response'][str(r.get('response'))]+=1
  counters['contextTruncated'][str(any(b['status']=='truncated' for b in a.get('context',{}).get('blocks',[])))]+=1
summary={'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'bytes':source.stat().st_size,'header':header,'records':len(rows),'uniqueIds':len({r['questionId'] for r in rows}),'uniqueQuestions':len({r['question'] for r in rows}),'consecutiveIndices':[r['index'] for r in rows]==list(range(len(rows))),'reportedDefects':sum(r['findings']['defect'] for r in rows),'reportedReviews':sum(r['findings']['review'] for r in rows),'counts':counters,'candidateCounts':{k:len(v) for k,v in flags.items()},'sizes':{k:{'min':min(v),'median':statistics.median(v),'p95':sorted(v)[int(.95*(len(v)-1))],'max':max(v)} for k,v in lengths.items()}}
(out/'metrics.json').write_text(json.dumps(summary,indent=2)+'\n')
with (out/'evidence.jsonl').open('w') as f:
 for k,items in flags.items():
  for item in items:f.write(json.dumps({'predicate':k,**item})+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='header'},indent=2))
