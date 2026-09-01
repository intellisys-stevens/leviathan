import { memo } from 'react';

export const PerimeterLight = memo(function PerimeterLight() {
  return (
    <span
      className="perimeter-light"
      data-slot="perimeter-light"
      aria-hidden="true"
    >
      <span className="perimeter-light-beam" data-slot="perimeter-light-beam" />
    </span>
  );
});
