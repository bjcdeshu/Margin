export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
  dataTestId?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  dataTestId,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      class="mp-toggle"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    />
  );
}
