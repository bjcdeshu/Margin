export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  fullWidth?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  fullWidth = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      class={fullWidth ? 'mp-segmented mp-segmented--full' : 'mp-segmented'}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const checked = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            class="mp-segmented-btn"
            aria-checked={checked ? 'true' : 'false'}
            title={opt.title}
            onClick={() => {
              if (!checked) onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
