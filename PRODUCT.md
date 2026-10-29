# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Researchers, scientific software teams, and technically fluent analysts who work with local or remote data and need an agent to carry a research question through scouting, evidence collection, analysis, review, and handoff.

## Product Purpose

Eve is a local-first scientific agent workspace. It turns a user's research wish into a durable, evidence-backed project with visible progress, reusable skills, and explicit human review. Success means users can see what is known, what remains uncertain, where evidence came from, and what should happen next without reading raw agent protocol data.

## Positioning

Eve combines wish-driven research, a durable run engine, project workspaces, optional multi-agent delegation, and review-gated self-improvement. Capabilities are loaded on demand from skills, every scientific claim keeps provenance, and generated memories or skills remain suggestions until the user accepts them.

## Operating Context

Users work in a browser-based workbench on Windows and connect to local or SSH projects. Work includes literature review, public biomedical data acquisition, multi-omics analysis, experiment design, visualization, long-running tasks, and recurring project reflection. Model providers may be cloud or local; offline use is a supported constraint.

## Capabilities and Constraints

- Durable runs and project state are owned by the existing run engine and platform store.
- Scientific outputs distinguish observations, inference, missing data, and diagnosis.
- Agent collaboration is self-initiated and appears as child agents in the sidebar; it is not a separate top-level workflow users must operate.
- Optional dreaming reflects over scoped, redacted, bounded session and memory context. It only creates pending candidates and never executes them.
- Sage is the verification gate for candidate promotion, not a separate autonomous scheduler.
- Skills and scientific tools are loaded on demand and remain outside the main application bundle where possible.
- Existing user data, settings, and unrelated working-tree changes must not be discarded.

## Brand Commitments

The product name is Eve. Interface copy is direct, calm, and specific. It avoids anthropomorphic sales language, feature self-description, and technical jargon when a plain action label is sufficient.

## Evidence on Hand

The repository contains the run engine, scientific workbench, public biomedical data skill, wish-driven research flow, child-agent sidebar, chart annotation, terminal, settings, and dashboard APIs. No fabricated benchmarks, scientific outcomes, or real-device claims should be added.

## Product Principles

1. Show the next useful action before explaining the system.
2. Preserve evidence and uncertainty at least as prominently as conclusions.
3. Keep autonomous exploration reversible and user-controlled.
4. Put high-frequency operational detail in side panels, not the main conversation.
5. Prefer one coherent interaction model over a collection of feature-specific entry points.

## Accessibility & Inclusion

Body and control text must meet WCAG AA contrast. Keyboard focus must remain visible. Motion must respect `prefers-reduced-motion`. Layouts must remain usable at narrow mobile widths without horizontal overflow.
