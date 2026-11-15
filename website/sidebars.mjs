const doc = (id, label) => ({ type: 'doc', id, label })
const section = (label, items, collapsed = true) => ({
  type: 'category',
  label,
  collapsible: true,
  collapsed,
  items
})

export default {
  docs: [
    doc('README', 'All guides'),
    section('Use Eris', [
      doc('ERIS_USAGE', 'User guide'),
      doc('PROFILE-SYNC', 'Account sync'),
      doc('image-generation', 'Image generation'),
      doc('FEEDBACK', 'Send feedback')
    ], false),
    section('How it works', [
      doc('ARCHITECTURE', 'Architecture'),
      doc('design/REQUEST-EXECUTION', 'Request execution'),
      doc('design/AUTO-MODEL-EXECUTION', 'Model selection'),
      doc('CONTEXT-MEMORY', 'Conversation memory'),
      section('RAM context design', [
        doc('RAM-CONTEXT-ARCHITECTURE', 'RAM architecture'),
        doc('RAM-CONTEXT-AMENDMENT-001', 'RAM and VRAM tiers')
      ])
    ]),
    section('Develop and test', [
      doc('ERIS-DEV', 'Eris-Dev guide'),
      doc('ERIS-DEV-LIVE-MODELS', 'Test with live models'),
      doc('DIAGNOSTICS-RUNS', 'Diagnostics and replay'),
      doc('GITHUB-WORKFLOW', 'GitHub workflow')
    ]),
    section('Release and operations', [
      doc('UPDATES', 'App updates'),
      doc('SIGNING', 'Signing and notarization'),
      doc('RECOVERY-RUNBOOKS', 'Recovery runbooks')
    ])
  ]
}
