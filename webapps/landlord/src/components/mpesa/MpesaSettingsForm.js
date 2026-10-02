import * as Yup from 'yup';
import { Form, Formik } from 'formik';
import {
  QueryKeys,
  registerMpesaUrls,
  simulateMpesaPayment,
  updateMpesaSettings
} from '../../utils/restcalls';
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import moment from 'moment';
import { Section } from '../formfields/Section';
import { SelectField } from '../formfields/SelectField';
import { SwitchField } from '../formfields/SwitchField';
import { TextField } from '../formfields/TextField';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

const validationSchema = Yup.object().shape({
  enabled: Yup.boolean().required(),
  environment: Yup.string().oneOf(['sandbox', 'production']).required(),
  shortCodeType: Yup.string().oneOf(['paybill', 'till']).required(),
  shortCode: Yup.string()
    .matches(/^\d{3,12}$/, { excludeEmptyString: true })
    .when('enabled', { is: true, then: Yup.string().required() }),
  consumerKey: Yup.string().when('enabled', {
    is: true,
    then: Yup.string().required()
  }),
  consumerSecret: Yup.string(),
  // the format is checked by the server, which also explains what is wrong
  callbackBaseUrl: Yup.string().when('enabled', {
    is: true,
    then: Yup.string().required()
  }),
  responseType: Yup.string().oneOf(['Completed', 'Cancelled']).required(),
  rejectUnknownAccounts: Yup.boolean().required()
});

function errorMessage(error, fallback) {
  return error?.response?.data?.message || fallback;
}

function UrlIssues({ issues }) {
  const { t } = useTranslation('common');
  const labels = {
    not_a_url: t('The public address is not a valid URL'),
    https_required: t('Safaricom requires an https address in production'),
    not_public: t('This address cannot be reached from the Internet'),
    forbidden_keyword: t(
      'Safaricom refuses addresses containing the words mpesa, safaricom, exe, cmd, sql or query'
    )
  };

  if (!issues?.length) {
    return null;
  }
  return (
    <ul className="text-sm text-destructive list-disc pl-5">
      {issues.map((issue) => (
        <li key={issue}>{labels[issue] || issue}</li>
      ))}
    </ul>
  );
}

function Registration({ settings }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: registerMpesaUrls,
    onSuccess: (updatedSettings) => {
      queryClient.setQueryData([QueryKeys.MPESA_SETTINGS], updatedSettings);
      toast.success(t('The addresses are registered with Safaricom'));
    },
    onError: (error) =>
      toast.error(errorMessage(error, t('Registration with Safaricom failed')))
  });

  return (
    <Section
      label={t('Registration with Safaricom')}
      description={t(
        'Safaricom sends every payment received on your short code to these addresses. Register them again after changing the short code, the environment or the public address.'
      )}
    >
      <div className="flex flex-col gap-3">
        {settings.confirmationUrl ? (
          <div className="text-sm">
            <div className="text-muted-foreground">{t('Validation URL')}</div>
            <div className="font-mono break-all">{settings.validationUrl}</div>
            <div className="text-muted-foreground mt-2">
              {t('Confirmation URL')}
            </div>
            <div className="font-mono break-all">
              {settings.confirmationUrl}
            </div>
            <div className="text-muted-foreground mt-2">
              {t(
                'Keep these addresses private: whoever knows them can declare payments'
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            {t('Save the configuration to get the addresses to register')}
          </div>
        )}
        <UrlIssues issues={settings.urlIssues} />
        <div className="text-sm">
          {settings.registeredAt
            ? t('Registered on {{date}}', {
                date: moment(settings.registeredAt).format('L LT')
              })
            : t('Not registered yet')}
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={
              !settings.confirmationUrl ||
              !!settings.urlIssues?.length ||
              register.isPending
            }
            onClick={() => register.mutate()}
          >
            {t('Register the addresses with Safaricom')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function SandboxTest({ settings }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('100');
  const [reference, setReference] = useState('');
  const simulate = useMutation({
    mutationFn: simulateMpesaPayment,
    onSuccess: () => {
      toast.success(
        t('Test payment sent, it will appear in the payments in a few seconds')
      );
      setTimeout(
        () =>
          queryClient.invalidateQueries({
            queryKey: [QueryKeys.MPESA_TRANSACTIONS]
          }),
        5000
      );
    },
    onError: (error) =>
      toast.error(errorMessage(error, t('The test payment failed')))
  });

  if (settings.environment !== 'sandbox' || !settings.registeredAt) {
    return null;
  }

  return (
    <Section
      label={t('Test payment')}
      description={t(
        'Asks the Safaricom sandbox to send a fake payment to this server'
      )}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="mpesaTestAmount" className="text-muted-foreground">
            {t('Amount')}
          </label>
          <Input
            id="mpesaTestAmount"
            type="number"
            min="1"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="mpesaTestReference" className="text-muted-foreground">
            {t('Account number')}
          </label>
          <Input
            id="mpesaTestReference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={simulate.isPending || !(Number(amount) > 0)}
          onClick={() => simulate.mutate({ amount: Number(amount), reference })}
        >
          {t('Send a test payment')}
        </Button>
      </div>
    </Section>
  );
}

export default function MpesaSettingsForm({ settings }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { mutateAsync } = useMutation({
    mutationFn: updateMpesaSettings,
    onSuccess: (updatedSettings) => {
      queryClient.setQueryData([QueryKeys.MPESA_SETTINGS], updatedSettings);
      toast.success(t('M-Pesa configuration saved'));
    },
    onError: (error) =>
      toast.error(
        errorMessage(error, t('Error saving the M-Pesa configuration'))
      )
  });

  const initialValues = useMemo(
    () => ({
      enabled: !!settings.enabled,
      environment: settings.environment || 'sandbox',
      shortCodeType: settings.shortCodeType || 'paybill',
      shortCode: settings.shortCode || '',
      consumerKey: settings.consumerKey || '',
      consumerSecret: '',
      callbackBaseUrl:
        settings.callbackBaseUrl ||
        (typeof window !== 'undefined' ? window.location.origin : ''),
      responseType: settings.responseType || 'Completed',
      rejectUnknownAccounts: !!settings.rejectUnknownAccounts
    }),
    [settings]
  );

  const environments = useMemo(
    () => [
      { id: 'sandbox', value: 'sandbox', label: t('Sandbox (tests)') },
      { id: 'production', value: 'production', label: t('Production') }
    ],
    [t]
  );
  const shortCodeTypes = useMemo(
    () => [
      { id: 'paybill', value: 'paybill', label: t('Paybill') },
      { id: 'till', value: 'till', label: t('Till (Buy Goods)') }
    ],
    [t]
  );
  const responseTypes = useMemo(
    () => [
      {
        id: 'Completed',
        value: 'Completed',
        label: t('Accept the payment')
      },
      { id: 'Cancelled', value: 'Cancelled', label: t('Cancel the payment') }
    ],
    [t]
  );

  const onSubmit = useCallback(
    async ({ consumerSecret, ...values }, { setFieldValue }) => {
      try {
        await mutateAsync({
          ...values,
          shortCode: values.shortCode.trim(),
          consumerKey: values.consumerKey.trim(),
          callbackBaseUrl: values.callbackBaseUrl.trim(),
          // the stored secret is kept when the field is left empty
          ...(consumerSecret ? { consumerSecret } : {})
        });
        setFieldValue('consumerSecret', '');
      } catch (error) {
        // reported by the mutation
      }
    },
    [mutateAsync]
  );

  return (
    <>
      <Formik
        initialValues={initialValues}
        validationSchema={validationSchema}
        onSubmit={onSubmit}
        enableReinitialize
      >
        {({ isSubmitting, values }) => (
          <Form autoComplete="off">
            <Section
              label={t('Daraja account')}
              description={t(
                'Credentials of your app on the Safaricom developer portal (Daraja)'
              )}
              className="flex flex-col gap-4"
            >
              <SwitchField
                label={t('Record the M-Pesa payments on the rents')}
                name="enabled"
              />
              <SelectField
                label={t('Environment')}
                name="environment"
                values={environments}
              />
              <SelectField
                label={t('Type of short code')}
                name="shortCodeType"
                values={shortCodeTypes}
              />
              <TextField label={t('Short code')} name="shortCode" />
              <TextField label={t('Consumer key')} name="consumerKey" />
              <TextField
                label={
                  settings.hasConsumerSecret
                    ? t('Consumer secret (leave empty to keep the current one)')
                    : t('Consumer secret')
                }
                name="consumerSecret"
                type="password"
                autoComplete="new-password"
              />
            </Section>
            <Section
              label={t('Receiving the payments')}
              className="flex flex-col gap-4"
            >
              <TextField
                label={t('Public address of this server (https)')}
                name="callbackBaseUrl"
              />
              {values.shortCodeType === 'paybill' ? (
                <SwitchField
                  label={t(
                    'Refuse the payments whose account number is not a tenant reference (requires the validation to be activated by Safaricom)'
                  )}
                  name="rejectUnknownAccounts"
                />
              ) : null}
              <SelectField
                label={t('When this server cannot be reached by Safaricom')}
                name="responseType"
                values={responseTypes}
              />
            </Section>
            <Button type="submit" disabled={isSubmitting}>
              {!isSubmitting ? t('Save') : t('Saving')}
            </Button>
          </Form>
        )}
      </Formik>
      <div className="mt-10">
        <Registration settings={settings} />
        <SandboxTest settings={settings} />
      </div>
    </>
  );
}
