import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Label, Popover, TextField, ToggleButton, Toolbar, Tooltip } from '@heroui/react';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { isSafeUrl, type RichTextDoc } from '../../rich-text';
import { pathKey, useEditor as useDocumentEditor } from './editor-context';

type RichTextInputProps = {
  label: string;
  required?: boolean;
  value: RichTextDoc | null;
  onChange: (value: RichTextDoc | null) => void;
  path: (string | number)[];
};

type Format = {
  id: string;
  label: string;
  icon: ReactNode;
  isActive: (editor: Editor) => boolean;
  toggle: (editor: Editor) => void;
};

const ICON = 'size-4';

const BLOCK_FORMATS: Format[] = [
  {
    id: 'heading-2',
    label: 'Titre',
    icon: <Heading2 aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
    toggle: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'heading-3',
    label: 'Sous-titre',
    icon: <Heading3 aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
    toggle: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
];

const MARK_FORMATS: Format[] = [
  {
    id: 'bold',
    label: 'Gras',
    icon: <Bold aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('bold'),
    toggle: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    label: 'Italique',
    icon: <Italic aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('italic'),
    toggle: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    id: 'underline',
    label: 'Souligné',
    icon: <Underline aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('underline'),
    toggle: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    id: 'strike',
    label: 'Barré',
    icon: <Strikethrough aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('strike'),
    toggle: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    id: 'code',
    label: 'Code',
    icon: <Code aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('code'),
    toggle: (editor) => editor.chain().focus().toggleCode().run(),
  },
];

const LIST_FORMATS: Format[] = [
  {
    id: 'bulletList',
    label: 'Liste à puces',
    icon: <List aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('bulletList'),
    toggle: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: 'Liste numérotée',
    icon: <ListOrdered aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('orderedList'),
    toggle: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'blockquote',
    label: 'Citation',
    icon: <Quote aria-hidden className={ICON} />,
    isActive: (editor) => editor.isActive('blockquote'),
    toggle: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
];

const ALL_FORMATS = [...BLOCK_FORMATS, ...MARK_FORMATS, ...LIST_FORMATS];

function ToolbarSeparator() {
  return <span aria-hidden className="mx-1 h-5 w-px self-center bg-[var(--separator)]" />;
}

function FormatButton({ format, editor, isSelected }: { format: Format; editor: Editor; isSelected: boolean }) {
  return (
    <Tooltip delay={500}>
      <ToggleButton
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={format.label}
        isSelected={isSelected}
        isDisabled={!editor.isEditable}
        onChange={() => format.toggle(editor)}
      >
        {format.icon}
      </ToggleButton>
      <Tooltip.Content>{format.label}</Tooltip.Content>
    </Tooltip>
  );
}

function ActionButton({
  label,
  icon,
  isDisabled,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  isDisabled: boolean;
  onPress: () => void;
}) {
  return (
    <Tooltip delay={500}>
      <Button isIconOnly size="sm" variant="ghost" aria-label={label} isDisabled={isDisabled} onPress={onPress}>
        {icon}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function LinkPopover({ editor, isActive }: { editor: Editor; isActive: boolean }) {
  const [isOpen, setOpen] = useState(false);
  const [href, setHref] = useState('');
  const [error, setError] = useState<string | null>(null);

  function open(next: boolean) {
    if (next) {
      setHref(String(editor.getAttributes('link').href ?? ''));
      setError(null);
    }
    setOpen(next);
  }

  function apply() {
    const value = href.trim();
    if (!value) return remove();
    if (!isSafeUrl(value)) {
      setError('Adresse refusée. Utilisez http, https, mailto, tel ou un chemin relatif.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run();
    setOpen(false);
  }

  function remove() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setOpen(false);
  }

  return (
    <Popover isOpen={isOpen} onOpenChange={open}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Lien"
        aria-pressed={isActive}
        isDisabled={!editor.isEditable}
        className={isActive ? 'bg-[var(--default)]' : undefined}
      >
        <Link2 aria-hidden className={ICON} />
      </Button>
      <Popover.Content placement="bottom start" className="w-80">
        <Popover.Dialog aria-label="Lien">
          <form
            className="flex flex-col gap-3 p-1"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              apply();
            }}
          >
            <TextField
              value={href}
              onChange={(next) => {
                setHref(next);
                setError(null);
              }}
              isInvalid={error !== null}
              validationBehavior="aria"
              autoFocus
              fullWidth
            >
              <Label>Adresse du lien</Label>
              <Input placeholder="https://… ou /page" className="genga-mono" />
            </TextField>
            {error && (
              <p role="alert" className="text-xs text-[var(--danger)]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {isActive && (
                <Button size="sm" variant="tertiary" onPress={remove}>
                  Retirer
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit">
                Appliquer
              </Button>
            </div>
          </form>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/**
 * A TipTap editor with its own toolbar. It allows only the nodes and marks that
 * `sanitizeRichText` keeps. It is uncontrolled: a controlled TipTap resets the cursor
 * at each keystroke. It remounts when the draft is replaced (`epoch`).
 */
export function RichTextInput(props: RichTextInputProps) {
  const { epoch } = useDocumentEditor();
  return <RichTextEditor key={epoch} {...props} />;
}

function RichTextEditor({ label, required, value, onChange, path }: RichTextInputProps) {
  const { errors, readOnly } = useDocumentEditor();
  const labelId = useId();
  const errorId = useId();
  const error = errors[pathKey(path)];
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    content: value ?? undefined,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          isAllowedUri: (url) => isSafeUrl(url),
        },
      }),
      Placeholder.configure({ placeholder: 'Écrivez ici…' }),
    ],
    onUpdate: ({ editor: current }) => onChangeRef.current(current.isEmpty ? null : (current.getJSON() as RichTextDoc)),
  });

  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-labelledby': labelId,
          ...(required ? { 'aria-required': 'true' } : {}),
          ...(error ? { 'aria-invalid': 'true', 'aria-describedby': errorId } : {}),
          class: 'genga-prose min-h-32 px-4 py-3 outline-none',
        },
      },
    });
  }, [editor, labelId, errorId, required, error]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      return {
        active: Object.fromEntries(ALL_FORMATS.map((format) => [format.id, format.isActive(current)])),
        link: current.isActive('link'),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      };
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="text-[var(--danger)]">
            {' '}
            *
          </span>
        )}
      </span>
      <div
        className={`overflow-hidden rounded-[var(--radius)] border bg-[var(--field-background)] focus-within:border-[var(--focus)] ${
          error ? 'border-[var(--danger)]' : 'border-[var(--field-border)]'
        }`}
      >
        {editor && state && (
          <Toolbar
            aria-label={`Mise en forme : ${label}`}
            className="flex flex-wrap items-center gap-0.5 border-b border-[var(--separator)] px-1.5 py-1"
          >
            {BLOCK_FORMATS.map((format) => (
              <FormatButton key={format.id} format={format} editor={editor} isSelected={state.active[format.id]} />
            ))}
            <ToolbarSeparator />
            {MARK_FORMATS.map((format) => (
              <FormatButton key={format.id} format={format} editor={editor} isSelected={state.active[format.id]} />
            ))}
            <ToolbarSeparator />
            {LIST_FORMATS.map((format) => (
              <FormatButton key={format.id} format={format} editor={editor} isSelected={state.active[format.id]} />
            ))}
            <LinkPopover editor={editor} isActive={state.link} />
            <ToolbarSeparator />
            <ActionButton
              label="Annuler"
              icon={<Undo2 aria-hidden className={ICON} />}
              isDisabled={!state.canUndo}
              onPress={() => editor.chain().focus().undo().run()}
            />
            <ActionButton
              label="Rétablir"
              icon={<Redo2 aria-hidden className={ICON} />}
              isDisabled={!state.canRedo}
              onPress={() => editor.chain().focus().redo().run()}
            />
          </Toolbar>
        )}
        <EditorContent editor={editor} />
      </div>
      {error && (
        <p id={errorId} className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
