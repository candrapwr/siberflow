// Inline SVG icons used throughout the UI. Kept as components for type-safety
// and so they inherit currentColor for theming.

import type { JSX } from "react";

type IconProps = { size?: number; className?: string };

function svg(path: JSX.Element, viewBox = "0 0 24 24") {
  return ({ size = 16, className }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const BrandIcon = svg(
  <>
    <path
      d="M18.5 5.5c-1.4-1.6-3.4-2.5-5.9-2.5-3.7 0-6.1 1.9-6.1 4.8 0 2.7 2.2 3.9 5.5 4.6 3 .6 5 1.4 5 3.4 0 1.8-1.7 3.2-4.7 3.2-2.5 0-4.7-.9-6.3-2.6"
      strokeWidth={1.9}
    />
    <path d="M5.2 5.4H3.3" strokeWidth={1.9} />
    <path d="M20.7 18.6h-1.9" strokeWidth={1.9} />
    <circle cx="2.6" cy="5.4" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="21.4" cy="18.6" r="1.1" fill="currentColor" stroke="none" />
  </>,
);

export const SendIcon = svg(<><path d="M12 19V5" strokeWidth={2.5} /><path d="M5 12l7-7 7 7" strokeWidth={2.5} /></>);
export const StopIcon = svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />);
export const SettingsIcon = svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>);
export const NewChatIcon = svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const TrashIcon = svg(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>);
export const FolderIcon = svg(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);
export const ChevronDownIcon = svg(<><path d="m6 9 6 6 6-6" /></>);
export const CopyIcon = svg(<><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>);
export const RefreshIcon = svg(<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>);
export const EditIcon = svg(<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" /></>);
export const ToolIcon = svg(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />);
export const ArrowDownIcon = svg(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
export const CheckIcon = svg(<><path d="M20 6L9 17l-5-5" strokeWidth={2.5} /></>);
export const SearchIcon = svg(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>);
export const PaperclipIcon = svg(<><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></>);
export const XIcon = svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
/** Spreadsheet document icon — used for .xlsx attachments. */
export const FileExcelIcon = svg(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h8" />
    <path d="M12 13v4" />
  </>,
);
/** Word document icon — used for .docx attachments. */
export const FileDocIcon = svg(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M9 13l1.5 5 1.5-4 1.5 4L15 13" />
  </>,
);
/** PDF document icon — used for .pdf attachments. */
export const FilePdfIcon = svg(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8.5 13v5h1.5a1.5 1.5 0 0 0 0-3H8.5" />
    <path d="M13 13v5h1.5a1.5 1.5 0 0 0 1.5-1.5v-2a1.5 1.5 0 0 0-1.5-1.5H13z" />
  </>,
);
