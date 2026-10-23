"""Read an Eris-Dev JSONL export as data; emit a reproducible whole-corpus audit.

Usage: python3 analyze_capture.py CAPTURE.jsonl QUESTIONS.txt [OUTPUT_DIRECTORY]
Flags are structural observations or review candidates, never model-answer scores.
"""
import collections
import csv
import hashlib
import json
import re
import statistics
import sys
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(capture_path, question_path, output):
    output.mkdir(parents=True, exist_ok=True)
    with capture_path.open(encoding='utf-8-sig') as stream:
        records = [json.loads(line) for line in stream if line.strip()]
    metadata, rows = records[0], records[1:]
    if metadata.get('format') != 'eris-dev-capture-v1':
        raise ValueError('This analyzer supports request-only eris-dev-capture-v1 exports.')
    questions = question_path.read_text(encoding='utf-8-sig').splitlines()
    if [r['index'] for r in rows] != list(range(len(rows))):
        raise ValueError('Capture indices are not consecutive and unique.')
    if [r['question'] for r in rows] != questions:
        raise ValueError('Question file and capture do not match exactly.')
    topics = set()
    for r in rows:
        for pattern in [r'^Can you write (.*?) so the happy path',
                        r'^I want (.*?) to be easy to reason about',
                        r'^Help me turn the requirement for (.*?) into production-ready code',
                        r'^How can I implement (.*?) without making']:
            match = re.search(pattern, r['question'])
            if match:
                topics.add(match[1])
    topic_order = sorted(topics, key=len, reverse=True)
    counters = {key: collections.Counter() for key in
                ['status', 'agent', 'intent', 'purpose', 'flags', 'topic', 'tool_count',
                 'prompt_variant', 'acceptance_criteria', 'topic_missing', 'response_fields']}
    question_audit = []
    regression_candidates = []
    lengths = collections.defaultdict(list)
    for r in rows:
        agent_calls = [q for q in r['requests'] if q['purpose'] == 'agent']
        if len(agent_calls) != 1:
            raise ValueError(f"Question {r['index'] + 1} has {len(agent_calls)} agent requests")
        request = agent_calls[0]
        system = '\n'.join(m['content'] for m in request['messages'] if m['role'] == 'system')
        tool_names = [tool['function']['name'] for tool in request.get('tools', [])]
        text = r['question']
        topic = next((t for t in topic_order if t in text), None)
        flags = []
        if r['intent'] == 'answer' and 'Make the requested changes' in system:
            flags.append('answer_has_edit_execution_plan')
        if not tool_names and ('read_file' in system or 'retrieve' in system):
            flags.append('tool_less_prompt_mentions_workspace_tools')
        if 'TASK CONTRACT\n' not in system:
            flags.append('compiled_prompt_omits_task_contract')
        if system.count('Shared rules (every role inherits these):') > 1:
            flags.append('shared_rules_duplicated')
        if r['intent'] == 'plan' and re.search(r'\b(example|function|production-ready code)\b', text, re.I):
            flags.append('code_artifact_request_routed_to_plan_candidate')
        if r['intent'] == 'verify' and not re.match(r'^(?:please\s+)?(?:verify|validate|test|check|confirm)\b', text, re.I):
            flags.append('verification_route_without_top_level_verification_request_candidate')
        if r['intent'] == 'capability' and 'data model and API' in text:
            flags.append('application_data_model_routed_to_eris_capability')
        if r['agent'] == 'Fast' and re.search(r'\b(write|example|implementation|function|code)\b', text, re.I):
            flags.append('fast_brief_answer_role_for_code_artifact_candidate')
        if 'generate_image' in tool_names:
            flags.append('image_tool_visible_in_images_disabled_capture')
        if r['intent'] == 'edit' and 'run' not in tool_names:
            flags.append('edit_prompt_requires_verification_without_initial_run_tool')
        if r['intent'] == 'verify' and topic and any(p in topic for p in ['verify downstream', 'test data']):
            flags.append('verification_route_correlates_with_topic_words_candidate')
        if r['intent'] == 'plan' and not re.search(r'\bplan\b', text, re.I):
            flags.append('plan_route_without_explicit_plan_word_candidate')
        if r['intent'] == 'edit' and re.search(r'How would you write it\?', text):
            flags.append('hypothetical_code_question_granted_edit_authority_candidate')
        counters['flags'].update(flags)
        for field in ['status', 'agent', 'intent']:
            counters[field].update([r.get(field)])
        counters['purpose'].update(q['purpose'] for q in r['requests'])
        counters['tool_count'].update([len(tool_names)])
        counters['topic'].update([topic or 'UNMATCHED'])
        if topic is None:
            counters['topic_missing'].update([text])
        counters['acceptance_criteria'].update(r['task']['acceptanceCriteria'])
        # Exclude the per-task JSON block so UUIDs and goals do not inflate variants.
        body = system.split('\n\n', 1)[-1] if system.startswith('TASK CONTRACT\n') else system
        counters['prompt_variant'].update([hashlib.sha256(body.encode()).hexdigest()])
        lengths[r['agent']].append({'system_chars': len(system),
                                  'tools_json_chars': len(json.dumps(request['tools'], separators=(',', ':'), ensure_ascii=False)),
                                  'question_chars': len(text)})
        answer = {k: r[k] for k in ['answer', 'response', 'modelResponse'] if k in r}
        counters['response_fields'].update(answer.keys())
        assessment = ('Confirmed request inconsistency' if any(f in flags for f in [
            'answer_has_edit_execution_plan', 'application_data_model_routed_to_eris_capability'])
            else 'Review candidate' if any(f.endswith('_candidate') for f in flags)
            else 'Prompt/capability observations; relevance requires response')
        question_audit.append({
            'question_number': r['index'] + 1, 'jsonl_line': r['index'] + 2,
            'question': text, 'topic': topic, 'agent': r['agent'], 'intent': r['intent'],
            'deliverable': r['task']['deliverable'], 'authority': r['task']['authority'],
            'request_count': len(r['requests']), 'initial_tool_names': tool_names,
            'scope_state': r['task']['scope']['state'],
            'capture_duration_ms': r['durationMs'], 'flags': flags,
            'assessment': assessment, 'answer_quality': 'not_observed',
            'expected_behavior': (
                'Answer the application data-model/API design question; do not use the Eris model catalog.'
                if 'application_data_model_routed_to_eris_capability' in flags else
                'Deliver the requested code/example or explanation with no mutation requirement for an answer; choose detail based on the requested artifact.'
                if r['intent'] == 'answer' else
                'Provide a usable code example; determine separately whether repository edits were requested.'
                if 'code_artifact_request_routed_to_plan_candidate' in flags else
                'Interpret the requested action independently from test/verify words inside the feature name; do not substitute running tests for writing or explaining a feature.'
                if r['intent'] == 'verify' else
                'Preserve the requested deliverable and mode authority; inspect relevant evidence and assess final relevance only after a response is observed.'
            )})
        if any(f in flags for f in [
            'application_data_model_routed_to_eris_capability',
            'verification_route_without_top_level_verification_request_candidate',
            'code_artifact_request_routed_to_plan_candidate',
            'fast_brief_answer_role_for_code_artifact_candidate',
            'hypothetical_code_question_granted_edit_authority_candidate']):
            regression_candidates.append(question_audit[-1])
    metrics = {
        'source': str(capture_path), 'source_sha256': sha(capture_path),
        'questions': str(question_path), 'questions_sha256': sha(question_path),
        'capture_metadata': metadata, 'records': len(rows), 'questions_match_exactly': True,
        'unique_questions': len(set(r['question'] for r in rows)),
        'observed_model_answers': sum(any(r.get(k) for k in ['answer', 'response', 'modelResponse']) for r in rows),
        'coverage': 'pre-inference request capture only',
        'candidate_flags_are_not_ground_truth': True,
        'counts': {key: dict(value) for key, value in counters.items()},
        'topic_count': len(topics),
        'capture_duration_ms': {'min': min(r['durationMs'] for r in rows),
                                'median': statistics.median(r['durationMs'] for r in rows),
                                'p95_nearest_rank': sorted(r['durationMs'] for r in rows)[max(0, (95 * len(rows) + 99) // 100 - 1)],
                                'max': max(r['durationMs'] for r in rows)},
        'request_size_chars_by_agent': {
            agent: {field: {'min': min(x[field] for x in data),
                            'median': statistics.median(x[field] for x in data),
                            'max': max(x[field] for x in data)}
                    for field in ['system_chars', 'tools_json_chars', 'question_chars']}
            for agent, data in lengths.items()},
        'additional_counts': {
            'all_requests_system_user_only': sum(
                all([m['role'] for m in q['messages']] == ['system', 'user'] for q in r['requests'])
                for r in rows),
            'agent_requests_with_retrieved_leads': sum(
                'Retrieved leads; verify before relying' in q['messages'][0]['content']
                for r in rows for q in r['requests'] if q['purpose'] == 'agent'),
            'tasks_with_recommendations': sum(bool(r['task']['recommendations']) for r in rows),
            'tasks_with_skills': sum(bool(r['task'].get('skillIds')) for r in rows),
            'unique_thread_ids': sorted(set(r['task']['threadId'] for r in rows), key=str),
            'unique_project_ids': sorted(set(r['task']['scope']['projectId'] for r in rows), key=str)},
        'method': 'All records scanned with explicit structural rules; selected examples and source reviewed manually. No live inference, response grading, or independently adjudicated 10,000-item intent labels.'}
    (output / 'metrics.json').write_text(json.dumps(metrics, indent=2, ensure_ascii=False) + '\n')
    (output / 'question-audit.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in question_audit))
    with (output / 'question-audit.csv').open('w', newline='', encoding='utf-8') as stream:
        columns = ['question_number', 'jsonl_line', 'question', 'topic', 'agent', 'intent', 'deliverable',
                   'request_count', 'scope_state', 'capture_duration_ms', 'assessment', 'answer_quality',
                   'flags', 'expected_behavior']
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for record in question_audit:
            writer.writerow({**record, 'flags': ';'.join(record['flags'])})
    (output / 'routing-regression-candidates.json').write_text(json.dumps({
        'status': 'Candidates for independent adjudication; not executable or gold labels',
        'source_sha256': metrics['source_sha256'],
        'cases': regression_candidates}, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({key: metrics[key] for key in ['records', 'topic_count', 'observed_model_answers', 'counts']}, indent=2))


if __name__ == '__main__':
    audit(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).parent)
