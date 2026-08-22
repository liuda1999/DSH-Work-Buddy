---
title: Attention Mechanism
description: A neural mechanism that lets models weigh the relevance of every token when building representations.
type: concept
tags: [deep-learning, transformers, attention]
created: 2026-08-18
updated: 2026-08-18
---

# Attention Mechanism

Attention computes a weighted sum over input representations, letting a
model focus on the most relevant tokens for each prediction.

## Scaled Dot-Product Attention

Queries and keys are dot-multiplied, scaled by sqrt(d_k), and normalized
with softmax to obtain attention weights.

## Why It Matters

Attention replaced recurrence in the transformer architecture and is the
core mechanism behind large language models. [[deepmind|DeepMind]] has
published extensively on scaling laws that build on attention-based models.
