# Contextual recall queries (#235)

Follow-up queries now use bounded active-file/resolved-recommendation hints and the latest eligible recent user source. The current query has higher lexical weight than all expansion units combined; explicit queries retain existing matching. Forgotten, cutoff and out-of-project recent rows cannot seed expansion. No model call is added; selection and durable probes retain the existing deadline and source checks. Manifests contain only expansion count and SHA-256 digest, never expanded text.

Validation: deterministic recall-quality and chat/context suites. Live recall quality and packaged/hardware latency are separate acceptance evidence; these changes do not certify them.
