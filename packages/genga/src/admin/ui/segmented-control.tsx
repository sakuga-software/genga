import type { ReactNode } from 'react';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

export type SegmentOption<K extends string> = { id: K; label: string; icon?: ReactNode };

type SegmentedControlProps<K extends string> = {
  label: string;
  options: SegmentOption<K>[];
  value: K;
  onChange: (value: K) => void;
  size?: 'sm' | 'md';
};

/**
 * One choice among a few options, as a group of toggle buttons.
 * An option with an icon shows only the icon. Its label stays the accessible name.
 */
export function SegmentedControl<K extends string>({
  label,
  options,
  value,
  onChange,
  size = 'sm',
}: SegmentedControlProps<K>) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      size={size}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [next] = keys;
        if (next !== undefined) onChange(String(next) as K);
      }}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.id}
          id={option.id}
          isIconOnly={Boolean(option.icon)}
          aria-label={option.icon ? option.label : undefined}
        >
          {option.icon ?? option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
