"use client";

import { FieldSchema, type FieldId, type IntakeTemplate } from "@nursebridge/contracts";
import { DEFAULT_TEMPLATE } from "@nursebridge/intake-policy";
import { useState, type Ref } from "react";
import { Notice } from "./workspace";
import "./intake-template-editor.css";

const FIELD_LABELS: Record<FieldId, string> = {
  reason: "Reason for calling",
  onset: "Onset",
  location: "Location",
  severity: "Severity",
  symptoms: "Other symptoms",
  medications: "Medication details",
  uncertainties: "Uncertain or unmeasured details",
  callback: "Callback number",
};

interface IntakeTemplateEditorProps {
  template: IntakeTemplate;
  busy: boolean;
  saving: boolean;
  dirty: boolean;
  cancelButtonRef: Ref<HTMLButtonElement>;
  onChange: (template: IntakeTemplate) => void;
  onSave: (template: IntakeTemplate) => void;
  onCancel: () => void;
}

export function IntakeTemplateEditor({ template, busy, saving, dirty, cancelButtonRef, onChange, onSave, onCancel }: IntakeTemplateEditorProps) {
  const [fieldToAdd, setFieldToAdd] = useState<FieldId | "">("");
  const [error, setError] = useState<string | null>(null);
  const unusedFields = FieldSchema.options.filter(field => !template.questions.some(question => question.field === field));
  const selectedField = unusedFields.includes(fieldToAdd as FieldId) ? fieldToAdd : unusedFields[0] ?? "";
  const update = (value: IntakeTemplate) => { setError(null); onChange(value); };
  const focusInput = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  const moveQuestion = (index: number, offset: number) => {
    const questions = [...template.questions];
    const target = index + offset;
    if (target < 0 || target >= questions.length) return;
    [questions[index], questions[target]] = [questions[target]!, questions[index]!];
    update({ ...template, questions });
  };
  const addQuestion = () => {
    const question = DEFAULT_TEMPLATE.questions.find(item => item.field === selectedField);
    if (!question || !unusedFields.includes(question.field)) return;
    update({ ...template, questions: [...template.questions, { ...question }] });
    setFieldToAdd("");
    focusInput(`question-${question.id}`);
  };
  const removeQuestion = (index: number) => {
    if (template.questions.length <= 1) return;
    const questions = template.questions.filter((_, number) => number !== index);
    update({ ...template, questions });
    focusInput(`question-${questions[Math.min(index, questions.length - 1)]!.id}`);
  };
  const removeAcknowledgment = (index: number) => {
    if (template.acknowledgments.length <= 1) return;
    const acknowledgments = template.acknowledgments.filter((_, number) => number !== index);
    update({ ...template, acknowledgments });
    focusInput(`acknowledgment-${Math.min(index, acknowledgments.length - 1)}`);
  };
  const submit = () => {
    const normalized = {
      ...template,
      name: template.name.trim(),
      opening: template.opening.trim(),
      questions: template.questions.map(question => ({ ...question, text: question.text.trim() })),
      acknowledgments: template.acknowledgments.map(message => message.trim()),
    };
    const invalidQuestion = normalized.questions.find(question => !question.text);
    const invalidAcknowledgment = normalized.acknowledgments.findIndex(message => !message);
    let validation: { message: string; id?: string } | null = null;
    if (!normalized.name) validation = { message: "Enter a template name.", id: "template-name" };
    else if (!normalized.opening) validation = { message: "Enter an opening question.", id: "template-opening" };
    else if (!normalized.questions.length || normalized.questions.length > 8 || new Set(normalized.questions.map(question => question.field)).size !== normalized.questions.length) validation = { message: "Choose between one and eight different intake questions." };
    else if (invalidQuestion) validation = { message: `Enter wording for ${FIELD_LABELS[invalidQuestion.field].toLowerCase()}.`, id: `question-${invalidQuestion.id}` };
    else if (!normalized.acknowledgments.length || normalized.acknowledgments.length > 8) validation = { message: "Include between one and eight acknowledgment messages." };
    else if (invalidAcknowledgment !== -1) validation = { message: `Enter acknowledgment ${invalidAcknowledgment + 1}.`, id: `acknowledgment-${invalidAcknowledgment}` };
    if (validation) {
      setError(validation.message);
      if (validation.id) focusInput(validation.id);
      return;
    }
    setError(null);
    onSave(normalized);
  };

  return <form className="form-grid intake-template-editor" aria-label="Edit intake template" onSubmit={event => { event.preventDefault(); if (!busy) submit(); }}>
    <div>
      <label className="field-label" htmlFor="template-name">Template name</label>
      <input className="text-input" id="template-name" maxLength={100} required disabled={busy} value={template.name} onChange={event => update({ ...template, name: event.target.value })} />
    </div>
    <div>
      <label className="field-label" htmlFor="template-opening">Approved opening question</label>
      <textarea className="text-input" id="template-opening" maxLength={500} required disabled={busy} value={template.opening} onChange={event => update({ ...template, opening: event.target.value })} />
      <p className="field-hint">The assistant adds the first question if it is not already included. The built-in opening follows your question order.</p>
    </div>
    <section aria-labelledby="intake-questions-heading" className="template-editor-section">
      <div><h3 id="intake-questions-heading">Intake questions</h3><p className="field-hint">Keep 1–8 questions. The assistant asks missing questions in this order.</p></div>
      {template.questions.map((question, index) => <fieldset className="template-editor-item" key={question.id} aria-label={`${FIELD_LABELS[question.field]} question`} disabled={busy}>
        <legend>{index + 1}. {FIELD_LABELS[question.field]} question</legend>
        <label className="field-label" htmlFor={`question-${question.id}`}>{FIELD_LABELS[question.field]}</label>
        <textarea className="text-input" id={`question-${question.id}`} maxLength={500} required value={question.text} onChange={event => update({ ...template, questions: template.questions.map((item, number) => number === index ? { ...item, text: event.target.value } : item) })} />
        <div className="template-item-actions">
          <button type="button" className="button small" aria-label={`Move ${FIELD_LABELS[question.field]} up`} disabled={busy || index === 0} onClick={() => moveQuestion(index, -1)}>Move up</button>
          <button type="button" className="button small" aria-label={`Move ${FIELD_LABELS[question.field]} down`} disabled={busy || index === template.questions.length - 1} onClick={() => moveQuestion(index, 1)}>Move down</button>
          <button type="button" className="button small danger" aria-label={`Remove ${FIELD_LABELS[question.field]} question`} disabled={busy || template.questions.length <= 1} onClick={() => removeQuestion(index)}>Remove</button>
        </div>
      </fieldset>)}
      <div className="template-add-question">
        <div><label className="field-label" htmlFor="template-field-to-add">Question to add</label><select id="template-field-to-add" className="text-input" disabled={busy || !unusedFields.length} value={selectedField} onChange={event => setFieldToAdd(event.target.value as FieldId)}>{unusedFields.length ? unusedFields.map(field => <option key={field} value={field}>{FIELD_LABELS[field]}</option>) : <option value="">All supported questions included</option>}</select></div>
        <button type="button" className="button" disabled={busy || !unusedFields.length} onClick={addQuestion}>Add question</button>
      </div>
    </section>
    <section aria-labelledby="template-acknowledgments-heading" className="template-editor-section">
      <div><h3 id="template-acknowledgments-heading">Acknowledgments</h3><p className="field-hint">Keep 1–8 approved messages. Earlier messages acknowledge answers; the last message is used when intake is complete. A single message serves both purposes.</p></div>
      {template.acknowledgments.map((message, index) => <div className="template-acknowledgment" key={index}>
        <label className="field-label" htmlFor={`acknowledgment-${index}`}>Acknowledgment {index + 1}</label>
        <textarea className="text-input" id={`acknowledgment-${index}`} maxLength={500} required disabled={busy} value={message} onChange={event => update({ ...template, acknowledgments: template.acknowledgments.map((item, number) => number === index ? event.target.value : item) })} />
        <button type="button" className="button small danger" aria-label={`Remove acknowledgment ${index + 1}`} disabled={busy || template.acknowledgments.length <= 1} onClick={() => removeAcknowledgment(index)}>Remove</button>
      </div>)}
      <div><button type="button" className="button" disabled={busy || template.acknowledgments.length >= 8} onClick={() => { update({ ...template, acknowledgments: [...template.acknowledgments, ""] }); focusInput(`acknowledgment-${template.acknowledgments.length}`); }}>Add acknowledgment</button></div>
    </section>
    <Notice kind="warning">Approved wording must collect patient-reported information only. Do not introduce diagnosis, treatment, reassurance, or advice that waiting is safe.</Notice>
    {error && <Notice kind="error">{error}</Notice>}
    <div className="template-editor-actions">
      <button className="button primary" disabled={busy || !dirty} type="submit">{saving ? "Saving template…" : "Save template"}</button>
      <button ref={cancelButtonRef} className="button" disabled={busy} type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
