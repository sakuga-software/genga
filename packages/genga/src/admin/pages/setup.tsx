import { Alert, Button, Description, Input, Label, TextField } from '@heroui/react';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { FormResult, SetupPageData } from '../../types';
import { AuthLayout } from './auth-layout';

export function SetupPage() {
  const data = useLoaderData() as SetupPageData;
  const result = useActionData() as FormResult | undefined;
  const busy = useNavigation().state !== 'idle';

  if (!data.valid) {
    return (
      <AuthLayout title="Lien invalide">
        <p className="text-sm text-[var(--muted)]">
          Ce lien a expiré ou a déjà servi. Demandez un nouveau lien à un administrateur.
        </p>
        <a href="/admin/login" className="mt-4 inline-block text-sm text-[var(--link)] underline underline-offset-4">
          Retour à la connexion
        </a>
      </AuthLayout>
    );
  }

  const isSetup = data.kind === 'setup';
  return (
    <AuthLayout
      title={isSetup ? 'Créer le premier administrateur' : 'Choisir un mot de passe'}
      description={isSetup ? 'Ce compte aura tous les droits.' : 'Ce lien ne sert qu’une fois.'}
    >
      <Form method="post" className="flex flex-col gap-4">
        <input type="hidden" name="token" value={data.token} />
        {result?.error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{result.error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <TextField name="name" defaultValue={data.name} autoComplete="name">
          <Label>Nom</Label>
          <Input />
        </TextField>
        <TextField
          name="email"
          type="email"
          isRequired
          isReadOnly={Boolean(data.email)}
          defaultValue={data.email ?? ''}
          autoComplete="username"
        >
          <Label>Email</Label>
          <Input />
        </TextField>
        <TextField name="password" type="password" isRequired minLength={12} autoComplete="new-password">
          <Label>Mot de passe</Label>
          <Input />
          <Description>12 caractères minimum.</Description>
        </TextField>
        <TextField name="confirm" type="password" isRequired minLength={12} autoComplete="new-password">
          <Label>Confirmer le mot de passe</Label>
          <Input />
        </TextField>
        <Button type="submit" variant="primary" fullWidth isPending={busy}>
          {isSetup ? 'Créer le compte' : 'Enregistrer'}
        </Button>
      </Form>
    </AuthLayout>
  );
}
