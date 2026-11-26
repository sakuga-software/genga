import { useState } from 'react';
import { Alert, Button, Checkbox, CheckboxGroup, Description, Label } from '@heroui/react';
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { API_SCOPES } from '../../access';
import { setAdminPath } from '../../client/admin-path';
import type { OAuthConsentPageData } from '../../types';
import { AuthLayout } from './auth-layout';
import { SCOPE_LABELS } from './scope-labels';

export function OAuthConsentPage() {
  const loaded = useLoaderData() as OAuthConsentPageData;
  const answered = useActionData() as OAuthConsentPageData | undefined;
  const page = answered ?? loaded;
  setAdminPath(page.adminPath);
  const busy = useNavigation().state !== 'idle';
  const [scopes, setScopes] = useState<string[]>(page.valid ? page.scopes : []);

  if (!page.valid) {
    return (
      <AuthLayout title="Demande impossible" description="Genga ne peut pas donner accès à cette application.">
        <p role="alert" className="text-sm">
          {page.message}
        </p>
      </AuthLayout>
    );
  }

  const { client } = page;
  return (
    <AuthLayout
      wide
      title="Autoriser l’accès"
      description={
        <>
          <strong className="text-[var(--foreground)]">{client.name}</strong> demande à agir sur ce site en votre nom.
        </>
      }
    >
      <Form
        method="post"
        reloadDocument
        action={`${page.adminPath}/oauth/authorize?${page.query}`}
        className="flex flex-col gap-5"
        aria-describedby={page.error ? 'consent-error' : undefined}
      >
        {page.error && (
          <Alert status="danger" id="consent-error">
            <Alert.Content>
              <Alert.Description>{page.error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--muted)]">Compte</dt>
          <dd className="min-w-0 break-words">
            {page.user.name ? `${page.user.name} (${page.user.email})` : page.user.email}
          </dd>
          <dt className="text-[var(--muted)]">Application</dt>
          <dd className="min-w-0 break-words">
            {client.metadataUrl ? (
              <>
                Décrite par <span className="genga-mono text-xs">{client.metadataUrl}</span>
              </>
            ) : (
              'Enregistrée automatiquement. Genga ne peut pas vérifier son nom.'
            )}
            {client.siteHost && <span className="block text-[var(--muted)]">Site annoncé : {client.siteHost}</span>}
          </dd>
          <dt className="text-[var(--muted)]">Retour vers</dt>
          <dd className="genga-mono min-w-0 break-all text-xs leading-5">{page.redirectTarget}</dd>
        </dl>

        {page.nativeRedirect && (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Title>Application sur votre ordinateur</Alert.Title>
              <Alert.Description>
                Genga ne peut pas vérifier l’identité d’une application installée sur un ordinateur. Continuez seulement
                si vous venez de lancer cette connexion vous-même.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        <CheckboxGroup value={scopes} onChange={setScopes} name="scope">
          <Label>Droits accordés</Label>
          <Description>
            Les droits demandés par l’application sont cochés. Ils restent dans la limite de votre rôle.
          </Description>
          <div className="mt-2 flex flex-col gap-3">
            {API_SCOPES.map((scope) => (
              <Checkbox key={scope} value={scope}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>{SCOPE_LABELS[scope].label}</Label>
                </Checkbox.Content>
                <Description>
                  {SCOPE_LABELS[scope].description}
                  {scope === 'publish' && !page.canPublish
                    ? ' Votre rôle ne permet pas de publier : ce droit restera sans effet.'
                    : ''}
                </Description>
              </Checkbox>
            ))}
          </div>
        </CheckboxGroup>

        <p className="text-xs text-[var(--muted)]">
          Vous pourrez retirer cet accès à tout moment dans Réglages › Jetons d’accès.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            name="decision"
            value="allow"
            variant="primary"
            isPending={busy}
            isDisabled={!scopes.length}
          >
            Autoriser
          </Button>
          <Button type="submit" name="decision" value="deny" variant="tertiary" isDisabled={busy}>
            Refuser
          </Button>
        </div>
      </Form>
    </AuthLayout>
  );
}
