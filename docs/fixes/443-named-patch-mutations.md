# Named patch completion evidence (#443)

The workflow records mutated paths separately from source reads. Requested file-set validation uses applied mutation evidence and host-reported changed paths; reading a pre-existing valid artifact no longer proves that it was generated or updated. Every requested generated output needs change evidence and retains the existing bounded syntax, project identity and independent verification checks. Unrelated mutations cannot satisfy the output set.

All patch tasks require observed workspace mutation, including named-file requests. Read-only review and verification are unchanged; deletion and rename are not turned into file-creation requirements. Existing already-correct code is not automatically rewritten or called completed: without requirement-specific no-op proof, the patch remains incomplete. The richer verified-no-op disposition is tracked separately in #457.

Regression coverage includes the zero-mutation counterexample, unrelated changes, partial file sets, successful creation, malformed artifacts and non-creation operations. Scripted loop checks remain distinct from real-model/platform acceptance.
