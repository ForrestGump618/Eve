# Reuse decision: III, independent implementation

Official upstream snapshot: `deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`. Read the detailed static audit in `../research/deepseek-harness-audit.md`.

I (upstream runtime as core) has the greatest Cordis/event/projection coupling and preview API upgrade cost. It still needs a new durable engine: the sampled workflow has no journaling/resume; default jobs die with the host. II (adapter) can isolate pinned components, but does not transfer idempotency or recovery guarantees. III keeps state/event/lease/outbox/checkpoint semantics under SuWen control, with the highest local implementation/test burden and smallest legacy-data migration surface.

Chosen: III now, with `DurableWorkflowEngine` and injected ActivityHandler boundaries available for II later. No upstream code is bundled. Existing baseline is Python, so this is a new TypeScript compatibility layer, not preservation of a pre-existing TS implementation. Preserve original Python sources, namespace, configuration and Apache license; new desktop code is MIT.

外部项目 contributes only static packaging observations. No observed runtime behavior or proprietary expression was used to implement this preview. Durable/Context requirements come from the supplied specification and independent engineering choices.
