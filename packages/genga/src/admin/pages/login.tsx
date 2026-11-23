import { Alert, Button, Input, Label, TextField } from '@heroui/react';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { setAdminPath } from '../../client/admin-path';
import type { FormResult, LoginPageData } from '../../types';
import { AuthLayout } from './auth-layout';

export function LoginPage() {
  const { needsSetup, next, adminPath } = useLoaderData() as LoginPageData;
  setAdminPath(adminPath);
  const result = useActionData() as FormResult | undefined;
  const busy = useNavigation().state !== 'idle';

  if (needsSetup) {
    return (
      <AuthLayout title="Premier démarrage" description="Aucun compte n’existe encore.">
        <p className="text-sm text-[var(--muted)]">
          Ouvrez le lien de configuration affiché dans les journaux du serveur pour créer le premier administrateur.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Connexion" description="Accédez à l’administration du site.">
      <Form method="post" className="flex flex-col gap-4" aria-describedby={result?.error ? 'login-error' : undefined}>
        <input type="hidden" name="next" value={next} />
        {result?.error && (
          <Alert status="danger" id="login-error">
            <Alert.Content>
              <Alert.Description>{result.error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <TextField name="email" type="email" isRequired autoComplete="username">
          <Label>Email</Label>
          <Input />
        </TextField>
        <TextField name="password" type="password" isRequired autoComplete="current-password">
          <Label>Mot de passe</Label>
          <Input />
        </TextField>
        <Button type="submit" variant="primary" fullWidth isPending={busy}>
          Se connecter
        </Button>
      </Form>
    </AuthLayout>
  );
}
