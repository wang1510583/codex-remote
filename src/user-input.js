// Request metadata is supplied by Codex, never inferred from assistant prose.
export function userInputDisplay(params = {}, createdAt = Date.now()) {
  const questions = (Array.isArray(params.questions) ? params.questions : []).map((q, index) => ({
    ...q,
    id: String(q.id || `question-${index}`),
    question: String(q.question || q.title || ""),
    options: Array.isArray(q.options) ? q.options.map(o => typeof o === "string" ? { label: o, description: "" } : o) : []
  }));
  const explicitTimeout = Number.isSafeInteger(params.autoResolutionMs) && params.autoResolutionMs >= 0;
  // Blocking permission/connector confirmations must stay manual. Some use
  // the same input RPC as ordinary questions; do not treat every input as safe.
  const permissionChoice = questions.some(q => q.options.some(o =>
    /^(accept|allow|approve|decline|deny|cancel|允许|批准|拒绝|取消)(\b|\s|[（(]|$)/i.test(String(o.label || ""))));
  const eligible = !permissionChoice && questions.length > 0 && questions.every(q =>
    !q.isSecret && q.options.length > 0 && q.options.every(o => typeof o.label === "string" && o.label.trim()))
    && (params.isBlocking === false || explicitTimeout);
  const autoResolutionMs = eligible ? (explicitTimeout ? params.autoResolutionMs : 60000) : null;
  return { questions, isBlocking: params.isBlocking !== false, autoResolutionMs,
    autoSubmitAt: autoResolutionMs === null ? null : createdAt + autoResolutionMs };
}

export function validateUserInputAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("请回答所有问题。");
  const result = Object.create(null);
  for (const q of questions) {
    const entry = Object.hasOwn(answers, q.id) ? answers[q.id] : null;
    const values = entry?.answers;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !values[0].trim() || values[0].length > 30000) throw new Error("请为每个问题选择一个选项或填写回答。");
    if (q.options.length && !q.isOther && !q.options.some(o => o.label === values[0])) throw new Error("所选答案不在选项中。");
    result[q.id] = { answers: values };
  }
  return result;
}
