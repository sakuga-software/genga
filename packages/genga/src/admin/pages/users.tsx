import { useState } from 'react';
import { Alert, Button, Chip, Input, Label, ListBox, Select, Table, TextField, toast } from '@heroui/react';
import { Copy } from 'lucide-react';
import { Form, useLoaderData, useRevalidator } from 'react-router';
import { ROLES, ROLE_LABELS, type Role } from '../../access';
import { ApiError, apiRequest } from '../../client/api';
import type { PublicUser, UsersPageData } from '../../types';
import { formatDate } from '../components/format';
import { PageHeader } from '../components/page-header';

function RoleSelect({
  value,
  onChange,
  label,
  isDisabled,
}: {
  value: Role;
  onChange: (role: Role) => void;
  label: string;
  isDisabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onChange={(key) => key && onChange(key as Role)}
      isDisabled={isDisabled}
      aria-label={label}
      className="w-44"
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {ROLES.map((role) => (
            <ListBox.Item key={role} id={role} textValue={ROLE_LABELS[role]}>
              {ROLE_LABELS[role]}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function OneTimeLink({ link, onDone }: { link: string; onDone: () => void }) {
  return (
    <Alert status="success" className="mb-6">
      <Alert.Content>
        <Alert.Title>Lien à usage unique</Alert.Title>
        <Alert.Description>
          Envoyez ce lien à la personne. Il expire dans 7 jours et ne sert qu’une fois. Il ne s’affichera plus.
          <span className="genga-mono mt-2 block break-all rounded bg-[var(--surface-secondary)] p-2 text-xs">
            {link}
          </span>
          <span className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void navigator.clipboard.writeText(link).then(() => toast.success('Lien copié'));
              }}
            >
              <Copy aria-hidden className="size-4" /> Copier
            </Button>
            <Button size="sm" variant="ghost" onPress={onDone}>
              Fermer
            </Button>
          </span>
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

export function UsersPage() {
  const { users, currentUserId } = useLoaderData() as UsersPageData;
  const revalidator = useRevalidator();
  const [role, setRole] = useState<Role>('author');
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invite(form: HTMLFormElement) {
    const data = new FormData(form);
    setInviting(true);
    setError(null);
    try {
      const result = await apiRequest<{ link: string }>('users', {
        method: 'POST',
        json: { email: data.get('email'), name: data.get('name'), role },
      });
      setLink(result.link);
      form.reset();
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Invitation impossible.');
    } finally {
      setInviting(false);
    }
  }

  async function update(user: PublicUser, change: { role?: Role; disabled?: boolean }) {
    try {
      await apiRequest(`users/${user.id}`, { method: 'PATCH', json: change });
      toast.success(
        change.disabled === true ? `${user.email} est désactivé. Ses sessions sont fermées.` : 'Utilisateur mis à jour',
      );
      revalidator.revalidate();
    } catch (caught) {
      toast.danger(caught instanceof ApiError ? caught.message : 'Action impossible.');
    }
  }

  async function reset(user: PublicUser) {
    try {
      const result = await apiRequest<{ link: string }>(`users/${user.id}/reset`, { method: 'POST' });
      setLink(result.link);
    } catch (caught) {
      toast.danger(caught instanceof ApiError ? caught.message : 'Action impossible.');
    }
  }

  return (
    <div className="p-6 md:p-10">
      <PageHeader
        title="Utilisateurs"
        description="Les auteurs écrivent et modifient leurs propres documents. Les éditeurs publient."
      />
      {link && <OneTimeLink link={link} onDone={() => setLink(null)} />}
      <section
        aria-labelledby="invite-heading"
        className="mb-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="invite-heading" className="genga-display mb-4 text-lg font-semibold">
          Inviter
        </h2>
        <Form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void invite(event.currentTarget);
          }}
        >
          <TextField name="email" type="email" isRequired className="min-w-64 flex-1">
            <Label>Email</Label>
            <Input />
          </TextField>
          <TextField name="name" className="min-w-48 flex-1">
            <Label>Nom</Label>
            <Input />
          </TextField>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium" id="invite-role">
              Rôle
            </span>
            <RoleSelect value={role} onChange={setRole} label="Rôle de la personne invitée" />
          </div>
          <Button type="submit" variant="primary" isPending={inviting}>
            Créer le lien d’invitation
          </Button>
        </Form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </section>
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Utilisateurs" className="min-w-[720px]">
            <Table.Header>
              <Table.Column isRowHeader>Personne</Table.Column>
              <Table.Column>Rôle</Table.Column>
              <Table.Column>État</Table.Column>
              <Table.Column>Actions</Table.Column>
            </Table.Header>
            <Table.Body>
              {users.map((user) => {
                const isSelf = user.id === currentUserId;
                return (
                  <Table.Row key={user.id} id={user.id}>
                    <Table.Cell>
                      <span className="block font-medium">{user.name || user.email}</span>
                      <span className="block text-xs text-[var(--muted)]">
                        {user.email} · depuis le {formatDate(user.createdAt)}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <RoleSelect
                        value={user.role}
                        onChange={(next) => void update(user, { role: next })}
                        label={`Rôle de ${user.email}`}
                        isDisabled={isSelf}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" variant="soft" color={user.disabled ? 'danger' : 'success'}>
                        {user.disabled ? 'Désactivé' : 'Actif'}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => void reset(user)}
                          aria-label={`Nouveau lien de mot de passe pour ${user.email}`}
                        >
                          Lien de mot de passe
                        </Button>
                        {!isSelf && (
                          <Button
                            size="sm"
                            variant={user.disabled ? 'secondary' : 'danger-soft'}
                            onPress={() => void update(user, { disabled: !user.disabled })}
                          >
                            {user.disabled ? 'Réactiver' : 'Désactiver'}
                          </Button>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}
