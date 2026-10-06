import { Card, CardContent } from '@/components/ui/card';
import { CopyButton } from '@/components/copy-button';
import { getFormatNumber } from '@/utils/formatnumber';
import getTranslation from '@/utils/i18n/server/getTranslation';
import type { Lease } from '@/types';
import type { ReactNode } from 'react';

function Step({ index, children }: { index: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
        {index}
      </span>
      <div className="flex min-w-0 grow flex-col gap-1 pt-0.5">{children}</div>
    </li>
  );
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="break-all font-mono text-2xl font-semibold tracking-wider">
          {value}
        </span>
        <CopyButton value={value} />
      </div>
    </>
  );
}

/**
 * Tells the tenant how to pay the rent with M-Pesa. Rendered only when the
 * landlord turned the M-Pesa payments on.
 */
export async function MpesaPayCard({ lease }: { lease: Lease }) {
  const mpesa = lease.landlord.mpesa;
  if (!mpesa?.shortCode) {
    return null;
  }

  const isPaybill = mpesa.shortCodeType === 'paybill';
  const reference = lease.tenant.reference || '';
  if (isPaybill && !reference) {
    // without an account number the payment could not be matched
    return null;
  }

  const { locale, t } = await getTranslation();
  const formatNumber = getFormatNumber(locale, lease.landlord.currency);
  const amountDue = lease.balance < 0 ? -lease.balance : 0;
  let index = 1;

  return (
    <Card className="shadow mb-6" data-cy="mpesaPayCard">
      <CardContent className="mt-6 flex flex-col gap-5">
        <div className="text-xl font-semibold">{t('Pay with M-Pesa')}</div>

        {mpesa.testMode ? (
          <div className="rounded-md border border-destructive p-3 text-sm font-semibold text-destructive">
            {t('Test mode: do not send real money to this number')}
          </div>
        ) : null}

        <ol className="flex flex-col gap-5">
          <Step index={index++}>
            <span>
              {t(
                'Open M-Pesa on your phone and choose Lipa na M-Pesa, then {{option}}',
                {
                  option: isPaybill
                    ? t('Pay Bill')
                    : t('Buy Goods and Services')
                }
              )}
            </span>
          </Step>
          <Step index={index++}>
            <CopyableValue
              label={isPaybill ? t('Business number') : t('Till number')}
              value={mpesa.shortCode}
            />
          </Step>
          {isPaybill ? (
            <Step index={index++}>
              <CopyableValue label={t('Account number')} value={reference} />
            </Step>
          ) : null}
          <Step index={index++}>
            <span className="text-sm text-muted-foreground">{t('Amount')}</span>
            <span className="text-lg font-semibold">
              {amountDue > 0
                ? t('Amount due: {{amount}}', {
                    amount: formatNumber({ value: amountDue })
                  })
                : t('Nothing is due at the moment')}
            </span>
            <span className="text-sm text-muted-foreground">
              {t('You can pay a different amount: it is added to your balance')}
            </span>
          </Step>
          <Step index={index++}>
            <span>{t('Enter your M-Pesa PIN and confirm')}</span>
          </Step>
        </ol>

        <div className="text-sm text-muted-foreground">
          {isPaybill
            ? t(
                'Your payment will appear here a few minutes after M-Pesa confirms it'
              )
            : t(
                'Tell your landlord after paying: a till payment carries no account number'
              )}
        </div>
      </CardContent>
    </Card>
  );
}
