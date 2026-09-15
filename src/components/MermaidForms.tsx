/* ---- Mermaid 图表可视化编辑：按图型拆分的结构化表单 ----
   每种表单只呈现「人能读懂的字段」（节点文本、连线起止、数据项…），
   不暴露 Mermaid 语法；改动经 onChange 回传模型，由调用方生成源码并预览。
   新增项自动聚焦其主输入框（autoFocus 依赖 React 的挂载期语义）。 */

import React, { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT, type MessageKey } from '../lib/i18nContext';
import {
  FLOW_DIRECTIONS,
  FLOW_SHAPES,
  FLOW_ARROWS,
  SEQ_ARROWS,
  GANTT_STATUSES,
  MIND_SHAPES,
  nextFlowId,
  todayStr,
  type FlowModel,
  type FlowNode,
  type FlowShape,
  type FlowArrow,
  type SeqModel,
  type SeqArrow,
  type PieModel,
  type XyModel,
  type GanttModel,
  type GanttStatus,
  type TimelineModel,
  type MindModel,
  type MindNode,
  type MindShape,
} from '../lib/mermaidModel';

/* ============================ 共享控件 ============================ */

const inputCls = (isDark: boolean) =>
  cn(
    'h-7 min-w-0 rounded-md border px-1.5 text-xs outline-none transition-colors',
    isDark
      ? 'bg-zinc-800 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500'
      : 'bg-white border-zinc-300 text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400',
  );

export function TextInput({
  value,
  onChange,
  placeholder,
  isDark,
  className,
  autoFocus,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  isDark: boolean;
  className?: string;
  autoFocus?: boolean;
  title?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      title={title}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn(inputCls(isDark), className)}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  isDark,
  className,
  title,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  isDark: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <select
      value={value}
      title={title}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(inputCls(isDark), 'cursor-pointer', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function IconBtn({
  onClick,
  title,
  isDark,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  isDark: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30',
        danger
          ? isDark
            ? 'text-zinc-500 hover:bg-zinc-700 hover:text-red-400'
            : 'text-zinc-400 hover:bg-zinc-100 hover:text-red-500'
          : isDark
            ? 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900',
      )}
    >
      {children}
    </button>
  );
}

function AddBtn({
  onClick,
  isDark,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  isDark: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1 text-[11px] transition-colors disabled:opacity-40',
        isDark
          ? 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
          : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:text-zinc-700',
      )}
    >
      <Plus size={12} />
      {children}
    </button>
  );
}

function Section({
  title,
  count,
  isDark,
  onAdd,
  addLabel,
  addDisabled,
  addTitle,
  children,
}: {
  title: string;
  count: number;
  isDark: boolean;
  onAdd: () => void;
  addLabel: string;
  addDisabled?: boolean;
  addTitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className={cn('flex items-center gap-1.5 text-[11px] font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
        <span>{title}</span>
        {count > 0 && (
          <span className={cn('rounded px-1 text-[10px] leading-4', isDark ? 'bg-zinc-700/60 text-zinc-400' : 'bg-zinc-100 text-zinc-500')}>
            {count}
          </span>
        )}
      </div>
      {children}
      <AddBtn onClick={onAdd} isDark={isDark} disabled={addDisabled} title={addTitle}>
        {addLabel}
      </AddBtn>
    </div>
  );
}

function EmptyHint({ isDark, children }: { isDark: boolean; children: React.ReactNode }) {
  return <div className={cn('px-1 py-0.5 text-[11px]', isDark ? 'text-zinc-600' : 'text-zinc-400')}>{children}</div>;
}

function Field({ label, isDark, className, children }: { label: string; isDark: boolean; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn('flex items-center gap-1.5', className)}>
      <span className={cn('shrink-0 text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-400')}>{label}</span>
      {children}
    </label>
  );
}

function Checkbox({ checked, onChange, isDark, label }: { checked: boolean; onChange: (v: boolean) => void; isDark: boolean; label: string }) {
  return (
    <label className={cn('flex shrink-0 cursor-pointer items-center gap-1 text-[11px]', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3 w-3 accent-[#96A5EB]" />
      {label}
    </label>
  );
}

interface FormProps<T> {
  model: T;
  onChange: (m: T) => void;
  isDark: boolean;
}

const listOf = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/* ============================ 选项表 ============================ */

const FLOW_SHAPE_KEYS: Record<FlowShape, MessageKey> = {
  rect: 'md.mm.shape.rect',
  round: 'md.mm.shape.round',
  stadium: 'md.mm.shape.stadium',
  subroutine: 'md.mm.shape.subroutine',
  cylinder: 'md.mm.shape.cylinder',
  circle: 'md.mm.shape.circle',
  diamond: 'md.mm.shape.diamond',
  hexagon: 'md.mm.shape.hexagon',
  asymmetric: 'md.mm.shape.asymmetric',
  parallelogram: 'md.mm.shape.parallelogram',
  parallelogramAlt: 'md.mm.shape.parallelogramAlt',
  trapezoid: 'md.mm.shape.trapezoid',
  trapezoidAlt: 'md.mm.shape.trapezoidAlt',
};

const FLOW_ARROW_KEYS: Record<FlowArrow, MessageKey> = {
  arrow: 'md.mm.arrow.arrow',
  open: 'md.mm.arrow.open',
  dottedArrow: 'md.mm.arrow.dottedArrow',
  dotted: 'md.mm.arrow.dotted',
  thickArrow: 'md.mm.arrow.thickArrow',
  thick: 'md.mm.arrow.thick',
};

const SEQ_ARROW_KEYS: Record<SeqArrow, MessageKey> = {
  solidArrow: 'md.mm.seq.solidArrow',
  dashedArrow: 'md.mm.seq.dashedArrow',
  solidOpen: 'md.mm.seq.solidOpen',
  dashedOpen: 'md.mm.seq.dashedOpen',
  solidCross: 'md.mm.seq.solidCross',
  dashedCross: 'md.mm.seq.dashedCross',
  solidAsync: 'md.mm.seq.solidAsync',
  dashedAsync: 'md.mm.seq.dashedAsync',
};

const GANTT_STATUS_KEYS: Record<GanttStatus, MessageKey> = {
  '': 'md.mm.status.none',
  done: 'md.mm.status.done',
  active: 'md.mm.status.active',
  crit: 'md.mm.status.crit',
  milestone: 'md.mm.status.milestone',
};

const MIND_SHAPE_KEYS: Record<MindShape, MessageKey> = {
  '': 'md.mm.shape.none',
  rect: 'md.mm.shape.rect',
  round: 'md.mm.shape.round',
  circle: 'md.mm.shape.circle',
  bang: 'md.mm.shape.bang',
  hexagon: 'md.mm.shape.hexagon',
  cloud: 'md.mm.shape.cloud',
};

/* ============================ 流程图 ============================ */

export function FlowchartForm({ model, onChange, isDark }: FormProps<FlowModel>) {
  const t = useT();
  const [focusId, setFocusId] = useState<string | null>(null);

  const nodeOptions = model.nodes.map((n) => ({ value: n.id, label: n.text && n.text !== n.id ? `${n.id} · ${n.text}` : n.id }));
  const patchNode = (i: number, patch: Partial<FlowNode>) =>
    onChange({ ...model, nodes: model.nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)) });

  return (
    <div className="space-y-3">
      <Field label={t('md.mm.direction')} isDark={isDark}>
        <Select
          value={model.direction}
          onChange={(v) => onChange({ ...model, direction: v })}
          options={FLOW_DIRECTIONS.map((d) => ({ value: d, label: t((`md.mm.dir.${d}`) as MessageKey) }))}
          isDark={isDark}
          className="w-28"
        />
      </Field>

      <Section
        title={t('md.mm.nodes')}
        count={model.nodes.length}
        isDark={isDark}
        onAdd={() => {
          const id = nextFlowId(model.nodes);
          setFocusId(id);
          onChange({ ...model, nodes: [...model.nodes, { id, text: '', shape: 'rect' }] });
        }}
        addLabel={t('md.mm.addNode')}
      >
        {model.nodes.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.emptyNodes')}</EmptyHint>}
        {model.nodes.map((n, i) => (
          <div key={n.id} className="flex items-center gap-1.5">
            <span className={cn('w-6 shrink-0 text-center text-[11px] font-medium', isDark ? 'text-zinc-500' : 'text-zinc-400')}>{n.id}</span>
            <Select
              value={n.shape}
              onChange={(v) => patchNode(i, { shape: v })}
              options={FLOW_SHAPES.map((s) => ({ value: s, label: t(FLOW_SHAPE_KEYS[s]) }))}
              isDark={isDark}
              className="w-[86px] shrink-0"
              title={t('md.mm.shape')}
            />
            <TextInput
              value={n.text}
              onChange={(v) => patchNode(i, { text: v })}
              placeholder={n.id}
              isDark={isDark}
              className="flex-1"
              autoFocus={focusId === n.id}
              title={t('md.mm.text')}
            />
            <IconBtn
              onClick={() =>
                onChange({
                  ...model,
                  nodes: model.nodes.filter((_, j) => j !== i),
                  edges: model.edges.filter((e) => e.from !== n.id && e.to !== n.id),
                })
              }
              title={t('md.mm.delNode')}
              isDark={isDark}
              danger
            >
              <Trash2 size={13} />
            </IconBtn>
          </div>
        ))}
      </Section>

      <Section
        title={t('md.mm.edges')}
        count={model.edges.length}
        isDark={isDark}
        onAdd={() => {
          if (model.nodes.length < 2) return;
          onChange({
            ...model,
            edges: [...model.edges, { from: model.nodes[0].id, to: model.nodes[1].id, label: '', arrow: 'arrow' }],
          });
        }}
        addLabel={t('md.mm.addEdge')}
        addDisabled={model.nodes.length < 2}
        addTitle={model.nodes.length < 2 ? t('md.mm.needTwoNodes') : undefined}
      >
        {model.edges.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.emptyEdges')}</EmptyHint>}
        {model.edges.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={e.from}
              onChange={(v) => onChange({ ...model, edges: model.edges.map((x, j) => (j === i ? { ...x, from: v } : x)) })}
              options={nodeOptions}
              isDark={isDark}
              className="w-[86px] shrink-0"
            />
            <Select
              value={e.arrow}
              onChange={(v) => onChange({ ...model, edges: model.edges.map((x, j) => (j === i ? { ...x, arrow: v } : x)) })}
              options={FLOW_ARROWS.map((a) => ({ value: a, label: t(FLOW_ARROW_KEYS[a]) }))}
              isDark={isDark}
              className="w-[92px] shrink-0"
              title={t('md.mm.arrow')}
            />
            <Select
              value={e.to}
              onChange={(v) => onChange({ ...model, edges: model.edges.map((x, j) => (j === i ? { ...x, to: v } : x)) })}
              options={nodeOptions}
              isDark={isDark}
              className="w-[86px] shrink-0"
            />
            <TextInput
              value={e.label}
              onChange={(v) => onChange({ ...model, edges: model.edges.map((x, j) => (j === i ? { ...x, label: v } : x)) })}
              placeholder={t('md.mm.label')}
              isDark={isDark}
              className="flex-1"
              title={t('md.mm.label')}
            />
            <IconBtn
              onClick={() => onChange({ ...model, edges: model.edges.filter((_, j) => j !== i) })}
              title={t('md.mm.delete')}
              isDark={isDark}
              danger
            >
              <Trash2 size={13} />
            </IconBtn>
          </div>
        ))}
      </Section>
    </div>
  );
}

/* ============================ 时序图 ============================ */

export function SequenceForm({ model, onChange, isDark }: FormProps<SeqModel>) {
  const t = useT();
  const [focusId, setFocusId] = useState<string | null>(null);

  const partOptions = model.participants.map((p) => ({ value: p.id, label: p.label && p.label !== p.id ? `${p.id} · ${p.label}` : p.id }));

  /** 改标识时同步改写消息里的引用；空 / 重名直接忽略 */
  const renameParticipant = (i: number, next: string) => {
    const oldId = model.participants[i].id;
    if (!next || next === oldId) return;
    if (model.participants.some((p, j) => j !== i && p.id === next)) return;
    onChange({
      ...model,
      participants: model.participants.map((p, j) => (j === i ? { ...p, id: next } : p)),
      messages: model.messages.map((m) => ({
        ...m,
        from: m.from === oldId ? next : m.from,
        to: m.to === oldId ? next : m.to,
      })),
    });
  };

  return (
    <div className="space-y-3">
      <Checkbox
        checked={model.autonumber}
        onChange={(v) => onChange({ ...model, autonumber: v })}
        isDark={isDark}
        label={t('md.mm.autonumber')}
      />

      <Section
        title={t('md.mm.participants')}
        count={model.participants.length}
        isDark={isDark}
        onAdd={() => {
          const id = `P${model.participants.length + 1}`;
          const uniq = model.participants.some((p) => p.id === id) ? `P${Date.now() % 1000}` : id;
          setFocusId(uniq);
          onChange({ ...model, participants: [...model.participants, { id: uniq, label: '', actor: false }] });
        }}
        addLabel={t('md.mm.addParticipant')}
      >
        {model.participants.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.participants.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1.5">
            <Select
              value={p.actor ? 'actor' : 'participant'}
              onChange={(v) => onChange({ ...model, participants: model.participants.map((x, j) => (j === i ? { ...x, actor: v === 'actor' } : x)) })}
              options={[
                { value: 'participant', label: t('md.mm.participant') },
                { value: 'actor', label: t('md.mm.actor') },
              ]}
              isDark={isDark}
              className="w-[72px] shrink-0"
            />
            <TextInput
              value={p.id}
              onChange={(v) => renameParticipant(i, v.trim())}
              isDark={isDark}
              className="w-[54px] shrink-0"
              title={t('md.mm.alias')}
            />
            <TextInput
              value={p.label}
              onChange={(v) => onChange({ ...model, participants: model.participants.map((x, j) => (j === i ? { ...x, label: v } : x)) })}
              placeholder={t('md.mm.displayName')}
              isDark={isDark}
              className="flex-1"
              autoFocus={focusId === p.id}
            />
            <IconBtn
              onClick={() =>
                onChange({
                  ...model,
                  participants: model.participants.filter((_, j) => j !== i),
                })
              }
              title={t('md.mm.delete')}
              isDark={isDark}
              danger
            >
              <Trash2 size={13} />
            </IconBtn>
          </div>
        ))}
      </Section>

      <Section
        title={t('md.mm.messages')}
        count={model.messages.length}
        isDark={isDark}
        onAdd={() => {
          if (model.participants.length < 2) return;
          onChange({
            ...model,
            messages: [...model.messages, { from: model.participants[0].id, to: model.participants[1].id, text: '', arrow: 'solidArrow' }],
          });
        }}
        addLabel={t('md.mm.addMessage')}
        addDisabled={model.participants.length < 2}
        addTitle={model.participants.length < 2 ? t('md.mm.needTwoNodes') : undefined}
      >
        {model.messages.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.messages.map((msg, i) => {
          const patch = (p: Partial<typeof msg>) => onChange({ ...model, messages: model.messages.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="flex items-center gap-1.5">
              <Select value={msg.from} onChange={(v) => patch({ from: v })} options={partOptions} isDark={isDark} className="w-[72px] shrink-0" />
              <Select
                value={msg.arrow}
                onChange={(v) => patch({ arrow: v })}
                options={SEQ_ARROWS.map((a) => ({ value: a, label: t(SEQ_ARROW_KEYS[a]) }))}
                isDark={isDark}
                className="w-[92px] shrink-0"
                title={t('md.mm.arrow')}
              />
              <Select value={msg.to} onChange={(v) => patch({ to: v })} options={partOptions} isDark={isDark} className="w-[72px] shrink-0" />
              <TextInput value={msg.text} onChange={(v) => patch({ text: v })} placeholder={t('md.mm.text')} isDark={isDark} className="flex-1" />
              <IconBtn onClick={() => onChange({ ...model, messages: model.messages.filter((_, j) => j !== i) })} title={t('md.mm.delete')} isDark={isDark} danger>
                <Trash2 size={13} />
              </IconBtn>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

/* ============================ 饼图 ============================ */

export function PieForm({ model, onChange, isDark }: FormProps<PieModel>) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Field label={t('md.mm.title')} isDark={isDark} className="flex-1">
          <TextInput value={model.title} onChange={(v) => onChange({ ...model, title: v })} isDark={isDark} className="flex-1" />
        </Field>
        <Checkbox checked={model.showData} onChange={(v) => onChange({ ...model, showData: v })} isDark={isDark} label={t('md.mm.showData')} />
      </div>

      <Section
        title={t('md.mm.pieItems')}
        count={model.items.length}
        isDark={isDark}
        onAdd={() => onChange({ ...model, items: [...model.items, { label: '', value: '' }] })}
        addLabel={t('md.mm.addItem')}
      >
        {model.items.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <TextInput
              value={it.label}
              onChange={(v) => onChange({ ...model, items: model.items.map((x, j) => (j === i ? { ...x, label: v } : x)) })}
              placeholder={t('md.mm.label')}
              isDark={isDark}
              className="flex-1"
            />
            <TextInput
              value={it.value}
              onChange={(v) => onChange({ ...model, items: model.items.map((x, j) => (j === i ? { ...x, value: v } : x)) })}
              placeholder={t('md.mm.value')}
              isDark={isDark}
              className="w-16 shrink-0"
            />
            <IconBtn onClick={() => onChange({ ...model, items: model.items.filter((_, j) => j !== i) })} title={t('md.mm.delete')} isDark={isDark} danger>
              <Trash2 size={13} />
            </IconBtn>
          </div>
        ))}
      </Section>
    </div>
  );
}

/* ============================ XY 统计图 ============================ */

export function XyChartForm({ model, onChange, isDark }: FormProps<XyModel>) {
  const t = useT();
  return (
    <div className="space-y-3">
      <Field label={t('md.mm.title')} isDark={isDark}>
        <TextInput value={model.title} onChange={(v) => onChange({ ...model, title: v })} isDark={isDark} className="flex-1" />
      </Field>
      <Field label={t('md.mm.xLabels')} isDark={isDark}>
        <TextInput value={model.xLabels} onChange={(v) => onChange({ ...model, xLabels: v })} isDark={isDark} className="flex-1" />
      </Field>
      <div className="flex items-center gap-1.5">
        <Field label={t('md.mm.yTitle')} isDark={isDark} className="flex-1">
          <TextInput value={model.yTitle} onChange={(v) => onChange({ ...model, yTitle: v })} isDark={isDark} className="flex-1" />
        </Field>
        <TextInput value={model.yMin} onChange={(v) => onChange({ ...model, yMin: v })} placeholder={t('md.mm.yMin')} isDark={isDark} className="w-14 shrink-0" />
        <TextInput value={model.yMax} onChange={(v) => onChange({ ...model, yMax: v })} placeholder={t('md.mm.yMax')} isDark={isDark} className="w-14 shrink-0" />
      </div>

      <Section
        title={t('md.mm.series')}
        count={model.series.length}
        isDark={isDark}
        onAdd={() => {
          /* 按 X 轴标签个数预填 0，避免空数据导致图表报错 */
          const n = listOf(model.xLabels).length;
          onChange({ ...model, series: [...model.series, { type: 'line', data: n ? Array(n).fill('0').join(', ') : '' }] });
        }}
        addLabel={t('md.mm.addSeries')}
      >
        {model.series.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.series.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={s.type}
              onChange={(v) => onChange({ ...model, series: model.series.map((x, j) => (j === i ? { ...x, type: v } : x)) })}
              options={[
                { value: 'line', label: t('md.mm.seriesLine') },
                { value: 'bar', label: t('md.mm.seriesBar') },
              ]}
              isDark={isDark}
              className="w-[68px] shrink-0"
            />
            <TextInput
              value={s.data}
              onChange={(v) => onChange({ ...model, series: model.series.map((x, j) => (j === i ? { ...x, data: v } : x)) })}
              placeholder={t('md.mm.seriesData')}
              isDark={isDark}
              className="flex-1"
              title={t('md.mm.seriesData')}
            />
            <IconBtn onClick={() => onChange({ ...model, series: model.series.filter((_, j) => j !== i) })} title={t('md.mm.delete')} isDark={isDark} danger>
              <Trash2 size={13} />
            </IconBtn>
          </div>
        ))}
      </Section>
    </div>
  );
}

/* ============================ 甘特图 ============================ */

export function GanttForm({ model, onChange, isDark }: FormProps<GanttModel>) {
  const t = useT();
  const [focusId, setFocusId] = useState<number | null>(null);
  const patch = (i: number, p: Partial<GanttModel['tasks'][number]>) =>
    onChange({ ...model, tasks: model.tasks.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Field label={t('md.mm.title')} isDark={isDark} className="flex-1">
          <TextInput value={model.title} onChange={(v) => onChange({ ...model, title: v })} isDark={isDark} className="flex-1" />
        </Field>
        <Field label={t('md.mm.dateFormat')} isDark={isDark}>
          <TextInput value={model.dateFormat} onChange={(v) => onChange({ ...model, dateFormat: v })} isDark={isDark} className="w-28 shrink-0" />
        </Field>
      </div>

      <Section
        title={t('md.mm.tasks')}
        count={model.tasks.length}
        isDark={isDark}
        onAdd={() => {
          setFocusId(model.tasks.length);
          onChange({
            ...model,
            tasks: [...model.tasks, { section: '', name: '', id: '', start: todayStr(), duration: '7d', status: '' }],
          });
        }}
        addLabel={t('md.mm.addTask')}
      >
        {model.tasks.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.tasks.map((task, i) => (
          <div key={i} className={cn('space-y-1.5 rounded-md border p-1.5', isDark ? 'border-zinc-700/70 bg-zinc-800/40' : 'border-zinc-200 bg-zinc-50/60')}>
            <div className="flex items-center gap-1.5">
              <TextInput
                value={task.section}
                onChange={(v) => patch(i, { section: v })}
                placeholder={t('md.mm.taskGroup')}
                isDark={isDark}
                className="w-20 shrink-0"
                title={t('md.mm.taskGroup')}
              />
              <TextInput
                value={task.name}
                onChange={(v) => patch(i, { name: v })}
                placeholder={t('md.mm.taskName')}
                isDark={isDark}
                className="flex-1"
                autoFocus={focusId === i}
              />
              <IconBtn onClick={() => onChange({ ...model, tasks: model.tasks.filter((_, j) => j !== i) })} title={t('md.mm.delete')} isDark={isDark} danger>
                <Trash2 size={13} />
              </IconBtn>
            </div>
            <div className="flex items-center gap-1.5">
              <TextInput
                value={task.start}
                onChange={(v) => patch(i, { start: v })}
                placeholder={t('md.mm.taskStart')}
                isDark={isDark}
                className="flex-1"
                title={t('md.mm.taskStart')}
              />
              <TextInput
                value={task.duration}
                onChange={(v) => patch(i, { duration: v })}
                placeholder={t('md.mm.taskDuration')}
                isDark={isDark}
                className="w-24 shrink-0"
                title={t('md.mm.taskDuration')}
              />
              <Select
                value={task.status}
                onChange={(v) => patch(i, { status: v })}
                options={GANTT_STATUSES.map((s) => ({ value: s, label: t(GANTT_STATUS_KEYS[s]) }))}
                isDark={isDark}
                className="w-[74px] shrink-0"
                title={t('md.mm.status')}
              />
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}

/* ============================ 时间线 ============================ */

export function TimelineForm({ model, onChange, isDark }: FormProps<TimelineModel>) {
  const t = useT();
  const patch = (i: number, p: Partial<TimelineModel['entries'][number]>) =>
    onChange({ ...model, entries: model.entries.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  return (
    <div className="space-y-3">
      <Field label={t('md.mm.title')} isDark={isDark}>
        <TextInput value={model.title} onChange={(v) => onChange({ ...model, title: v })} isDark={isDark} className="flex-1" />
      </Field>

      <Section
        title={t('md.mm.entries')}
        count={model.entries.length}
        isDark={isDark}
        onAdd={() => onChange({ ...model, entries: [...model.entries, { section: '', time: '', events: '' }] })}
        addLabel={t('md.mm.addEntry')}
      >
        {model.entries.length === 0 && <EmptyHint isDark={isDark}>{t('md.mm.empty')}</EmptyHint>}
        {model.entries.map((e, i) => (
          <div key={i} className="space-y-1.5 rounded-md border p-1.5" style={{ borderColor: isDark ? 'rgba(63,63,70,0.7)' : '#e4e4e7' }}>
            <div className="flex items-center gap-1.5">
              <TextInput
                value={e.time}
                onChange={(v) => patch(i, { time: v })}
                placeholder={t('md.mm.time')}
                isDark={isDark}
                className="w-28 shrink-0"
                autoFocus={i === model.entries.length - 1 && !e.section && !e.time && !e.events}
              />
              <TextInput
                value={e.section}
                onChange={(v) => patch(i, { section: v })}
                placeholder={t('md.mm.taskGroup')}
                isDark={isDark}
                className="w-24 shrink-0"
              />
              <IconBtn onClick={() => onChange({ ...model, entries: model.entries.filter((_, j) => j !== i) })} title={t('md.mm.delete')} isDark={isDark} danger>
                <Trash2 size={13} />
              </IconBtn>
            </div>
            <TextInput
              value={e.events}
              onChange={(v) => patch(i, { events: v })}
              placeholder={t('md.mm.events')}
              isDark={isDark}
              className="w-full"
              title={t('md.mm.events')}
            />
          </div>
        ))}
      </Section>
    </div>
  );
}

/* ============================ 思维导图 ============================ */

function updateMindAt(root: MindNode, path: number[], fn: (n: MindNode) => MindNode): MindNode {
  if (path.length === 0) return fn(root);
  const [head, ...rest] = path;
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? updateMindAt(c, rest, fn) : c)),
  };
}

function insertMindChild(root: MindNode, path: number[]): MindNode {
  return updateMindAt(root, path, (n) => ({ ...n, children: [...n.children, { text: '', shape: '', children: [] }] }));
}

function removeMindAt(root: MindNode, path: number[]): MindNode {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  return updateMindAt(root, parentPath, (n) => ({ ...n, children: n.children.filter((_, i) => i !== idx) }));
}

function moveMindAt(root: MindNode, path: number[], dir: -1 | 1): MindNode {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  return updateMindAt(root, parentPath, (n) => {
    const next = idx + dir;
    if (next < 0 || next >= n.children.length) return n;
    const children = [...n.children];
    const [item] = children.splice(idx, 1);
    children.splice(next, 0, item);
    return { ...n, children };
  });
}

/** 取树中某个路径上的节点 */
function mindAt(root: MindNode, path: number[]): MindNode {
  let n = root;
  for (const i of path) n = n.children[i];
  return n;
}

function MindTree({
  node,
  path,
  isDark,
  focusPath,
  onPatch,
  onAddChild,
  onRemove,
  onMove,
}: {
  node: MindNode;
  path: number[];
  isDark: boolean;
  focusPath: string | null;
  onPatch: (path: number[], p: Partial<MindNode>) => void;
  onAddChild: (path: number[]) => void;
  onRemove: (path: number[]) => void;
  onMove: (path: number[], dir: -1 | 1) => void;
}) {
  const t = useT();
  const isRoot = path.length === 0;
  return (
    <div className="space-y-1.5">
      {/* 子节点用左侧竖线 + 缩进体现层级，避免整棵树看起来"挤在一起" */}
      <div
        className={cn('flex items-center gap-1.5', !isRoot && 'ml-3.5 border-l pl-2')}
        style={!isRoot ? { borderColor: isDark ? '#3f3f46' : '#e4e4e7' } : undefined}
      >
        <Select
          value={node.shape}
          onChange={(v) => onPatch(path, { shape: v })}
          options={MIND_SHAPES.map((s) => ({ value: s, label: t(MIND_SHAPE_KEYS[s]) }))}
          isDark={isDark}
          className="w-[68px] shrink-0"
          title={t('md.mm.shape')}
        />
        <TextInput
          value={node.text}
          onChange={(v) => onPatch(path, { text: v })}
          placeholder={isRoot ? t('md.mm.rootNode') : t('md.mm.text')}
          isDark={isDark}
          className="flex-1"
          autoFocus={focusPath === path.join('.')}
        />
        <button
          type="button"
          onClick={() => onAddChild(path)}
          title={t('md.mm.addChild')}
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-md border transition-colors',
            isDark
              ? 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100'
              : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:text-zinc-800',
          )}
        >
          <Plus size={13} />
        </button>
        {!isRoot && (
          <>
            <IconBtn onClick={() => onMove(path, -1)} title={t('md.mm.moveUp')} isDark={isDark}>
              <ChevronUp size={13} />
            </IconBtn>
            <IconBtn onClick={() => onMove(path, 1)} title={t('md.mm.moveDown')} isDark={isDark}>
              <ChevronDown size={13} />
            </IconBtn>
            <IconBtn onClick={() => onRemove(path)} title={t('md.mm.delete')} isDark={isDark} danger>
              <Trash2 size={13} />
            </IconBtn>
          </>
        )}
      </div>
      {node.children.map((c, i) => (
        <MindTree
          key={i}
          node={c}
          path={[...path, i]}
          isDark={isDark}
          focusPath={focusPath}
          onPatch={onPatch}
          onAddChild={onAddChild}
          onRemove={onRemove}
          onMove={onMove}
        />
      ))}
    </div>
  );
}

export function MindmapForm({ model, onChange, isDark }: FormProps<MindModel>) {
  const t = useT();
  const [focusPath, setFocusPath] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className={cn('text-[11px] font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500')}>{t('md.mm.rootNode')}</div>
      <MindTree
        node={model.root}
        path={[]}
        isDark={isDark}
        focusPath={focusPath}
        onPatch={(path, p) => onChange({ ...model, root: updateMindAt(model.root, path, (n) => ({ ...n, ...p })) })}
        onAddChild={(path) => {
          /* 新子节点落在 children 末尾，插入前先算出它的路径用于聚焦 */
          setFocusPath([...path, mindAt(model.root, path).children.length].join('.'));
          onChange({ ...model, root: insertMindChild(model.root, path) });
        }}
        onRemove={(path) => onChange({ ...model, root: removeMindAt(model.root, path) })}
        onMove={(path, dir) => onChange({ ...model, root: moveMindAt(model.root, path, dir) })}
      />
      {/* 明显的总入口：往根节点下加一个子节点（行内 + 按钮则加在当前节点下） */}
      <AddBtn
        onClick={() => {
          setFocusPath([mindAt(model.root, []).children.length].join('.'));
          onChange({ ...model, root: insertMindChild(model.root, []) });
        }}
        isDark={isDark}
      >
        {t('md.mm.addNode')}
      </AddBtn>
    </div>
  );
}
