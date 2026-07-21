/**
 * Compatibility wrappers around @clack/prompts.
 *
 * The project still emits CommonJS, while @clack/prompts is ESM-only. Keep the
 * runtime import behind an ESM bridge so compiled output never calls require().
 */
type ClackPrompts = typeof import('@clack/prompts');
type ClackPromptModule = Pick<
  ClackPrompts,
  'select' | 'confirm' | 'multiselect' | 'isCancel' | 'cancel'
>;

const importEsm = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<ClackPromptModule>;

let clackPromise: Promise<ClackPromptModule> | null = null;

function defaultLoadClack(): Promise<ClackPromptModule> {
  clackPromise ??= importEsm('@clack/prompts');
  return clackPromise;
}

let loadClack = defaultLoadClack;

type PromptChoice<Value> = {
  value: Value;
  name?: string;
  label?: string;
  description?: string;
  hint?: string;
  short?: string;
  disabled?: boolean | string;
  checked?: boolean;
  type?: never;
};

type PrimitiveChoiceValue = Readonly<string | boolean | number>;
type ClackPromptOption<Value> = Value extends PrimitiveChoiceValue
  ? {
      value: Value;
      label?: string;
      hint?: string;
      disabled?: boolean;
    }
  : {
      value: Value;
      label: string;
      hint?: string;
      disabled?: boolean;
    };

type SelectOptions<Value> = Parameters<typeof import('@clack/prompts').select<Value>>[0]['options'];
type MultiselectOptions<Value> = Parameters<typeof import('@clack/prompts').multiselect<Value>>[0]['options'];

export class Separator {
  readonly type = 'separator';

  constructor(readonly separator = '') {}
}

export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
    Object.setPrototypeOf(this, PromptCancelledError.prototype);
  }
}

export function isPromptCancelled(error: unknown): boolean {
  return error instanceof PromptCancelledError;
}

function isSeparator(choice: unknown): choice is Separator {
  return choice instanceof Separator;
}

function getChoiceLabel<Value>(choice: PromptChoice<Value>): string {
  return choice.label ?? choice.name ?? String(choice.value);
}

function getChoiceHint<Value>(choice: PromptChoice<Value>): string | undefined {
  const hint = choice.hint ?? choice.description;

  if (typeof choice.disabled !== 'string' || choice.disabled.length === 0) {
    return hint;
  }

  return hint ? `${hint} (${choice.disabled})` : choice.disabled;
}

function mapChoicesToOptions<Value>(
  choices: ReadonlyArray<PromptChoice<Value> | Separator>
): ClackPromptOption<Value>[] {
  return choices.flatMap((choice) => {
    if (isSeparator(choice)) {
      return [];
    }

    const option = {
      value: choice.value,
      label: getChoiceLabel(choice),
    } as ClackPromptOption<Value>;
    const hint = getChoiceHint(choice);

    if (hint !== undefined) {
      option.hint = hint;
    }

    if (Boolean(choice.disabled)) {
      option.disabled = true;
    }

    return [option];
  });
}

function mapCheckedValues<Value>(
  choices: ReadonlyArray<PromptChoice<Value> | Separator>
): Value[] {
  return choices.flatMap((choice) => {
    if (isSeparator(choice) || !choice.checked) {
      return [];
    }

    return [choice.value];
  });
}

function unwrapPromptResult<Value>(
  clack: Pick<ClackPromptModule, 'isCancel' | 'cancel'>,
  result: Value | symbol
): Value {
  if (clack.isCancel(result)) {
    clack.cancel('Prompt cancelled');
    throw new PromptCancelledError();
  }

  return result as Value;
}

export async function themedSelect<Value>(config: {
  message: string;
  choices: ReadonlyArray<PromptChoice<Value> | Separator>;
  default?: unknown;
  pageSize?: number;
  loop?: boolean;
}): Promise<Value> {
  const clack = await loadClack();
  const result = await clack.select<Value>({
    message: config.message,
    options: mapChoicesToOptions(config.choices) as SelectOptions<Value>,
    initialValue: config.default as Value | undefined,
    maxItems: config.pageSize,
  });

  return unwrapPromptResult(clack, result);
}

export async function themedConfirm(config: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  const clack = await loadClack();
  const result = await clack.confirm({
    message: config.message,
    initialValue: config.default,
  });

  return unwrapPromptResult(clack, result);
}

export async function themedCheckbox<Value>(config: {
  message: string;
  choices: ReadonlyArray<PromptChoice<Value> | Separator>;
  pageSize?: number;
}): Promise<Value[]> {
  const clack = await loadClack();
  const result = await clack.multiselect<Value>({
    message: config.message,
    options: mapChoicesToOptions(config.choices) as MultiselectOptions<Value>,
    initialValues: mapCheckedValues(config.choices),
    maxItems: config.pageSize,
    required: false,
  });

  return unwrapPromptResult(clack, result);
}

export const themedPromptTestHooks = {
  setClackModule(module: ClackPromptModule): void {
    clackPromise = null;
    loadClack = async () => module;
  },
  resetClackModule(): void {
    clackPromise = null;
    loadClack = defaultLoadClack;
  },
  mapChoicesToOptions,
  mapCheckedValues,
  unwrapPromptResult,
};
