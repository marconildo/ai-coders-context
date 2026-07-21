import {
  PromptCancelledError,
  Separator,
  isPromptCancelled,
  themedCheckbox,
  themedConfirm,
  themedPromptTestHooks,
  themedSelect,
} from '../themedPrompt';

describe('themedPrompt', () => {
  const cancelSymbol = Symbol('cancel');

  function createClackModule() {
    return {
      select: jest.fn(),
      confirm: jest.fn(),
      multiselect: jest.fn(),
      isCancel: jest.fn((value: unknown) => value === cancelSymbol),
      cancel: jest.fn(),
    };
  }

  function installClackModule(clack: ReturnType<typeof createClackModule>): void {
    themedPromptTestHooks.setClackModule(
      clack as unknown as Parameters<typeof themedPromptTestHooks.setClackModule>[0]
    );
  }

  afterEach(() => {
    themedPromptTestHooks.resetClackModule();
    jest.clearAllMocks();
  });

  it('maps select choices to Clack options', async () => {
    const clack = createClackModule();
    clack.select.mockResolvedValue('beta');
    installClackModule(clack);

    const result = await themedSelect({
      message: 'Choose one',
      choices: [
        { value: 'alpha', name: 'Alpha', description: 'First option' },
        new Separator(),
        { value: 'beta', label: 'Beta', hint: 'Second option', disabled: 'Not ready' },
        { value: 'gamma' },
      ],
      default: 'alpha',
      pageSize: 8,
    });

    expect(result).toBe('beta');
    expect(clack.select).toHaveBeenCalledWith({
      message: 'Choose one',
      options: [
        { value: 'alpha', label: 'Alpha', hint: 'First option' },
        { value: 'beta', label: 'Beta', hint: 'Second option (Not ready)', disabled: true },
        { value: 'gamma', label: 'gamma' },
      ],
      initialValue: 'alpha',
      maxItems: 8,
    });
  });

  it('maps checked checkbox choices to initialValues', async () => {
    const clack = createClackModule();
    clack.multiselect.mockResolvedValue(['typescript']);
    installClackModule(clack);

    const result = await themedCheckbox({
      message: 'Pick languages',
      choices: [
        { name: 'TypeScript', value: 'typescript', checked: true },
        new Separator(),
        { name: 'JavaScript', value: 'javascript' },
      ],
      pageSize: 5,
    });

    expect(result).toEqual(['typescript']);
    expect(clack.multiselect).toHaveBeenCalledWith({
      message: 'Pick languages',
      options: [
        { value: 'typescript', label: 'TypeScript' },
        { value: 'javascript', label: 'JavaScript' },
      ],
      initialValues: ['typescript'],
      maxItems: 5,
      required: false,
    });
  });

  it('maps confirm defaults to Clack initialValue', async () => {
    const clack = createClackModule();
    clack.confirm.mockResolvedValue(false);
    installClackModule(clack);

    const result = await themedConfirm({
      message: 'Proceed?',
      default: true,
    });

    expect(result).toBe(false);
    expect(clack.confirm).toHaveBeenCalledWith({
      message: 'Proceed?',
      initialValue: true,
    });
  });

  it('converts Clack cancellation to PromptCancelledError', async () => {
    const clack = createClackModule();
    clack.confirm.mockResolvedValue(cancelSymbol);
    installClackModule(clack);

    await expect(themedConfirm({ message: 'Proceed?' })).rejects.toBeInstanceOf(PromptCancelledError);

    expect(clack.cancel).toHaveBeenCalledWith('Prompt cancelled');
  });

  it('identifies prompt cancellation errors', () => {
    expect(isPromptCancelled(new PromptCancelledError())).toBe(true);
    expect(isPromptCancelled(new Error('Prompt cancelled'))).toBe(false);
  });
});
