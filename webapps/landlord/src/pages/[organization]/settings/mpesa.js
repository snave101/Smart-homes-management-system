import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '../../../components/ui/card';
import { fetchMpesaSettings, QueryKeys } from '../../../utils/restcalls';
import MpesaSettingsForm from '../../../components/mpesa/MpesaSettingsForm';
import MpesaTransactions from '../../../components/mpesa/MpesaTransactions';
import Page from '../../../components/Page';
import { StoreContext } from '../../../store';
import { toast } from 'sonner';
import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import useTranslation from 'next-translate/useTranslation';
import { withAuthentication } from '../../../components/Authentication';

function MpesaConfiguration() {
  const { t } = useTranslation('common');
  const {
    data: settings,
    isError,
    isLoading
  } = useQuery({
    queryKey: [QueryKeys.MPESA_SETTINGS],
    queryFn: fetchMpesaSettings
  });

  if (isError) {
    toast.error(t('Error fetching the M-Pesa configuration'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('M-Pesa configuration')}</CardTitle>
        <CardDescription>
          {t(
            'Tenants pay to your Paybill using their tenant reference as account number, the payment is then recorded on their rent'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isLoading && settings ? (
          <MpesaSettingsForm settings={settings} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function MpesaSettings() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);

  return (
    <Page dataCy="mpesaPage">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('M-Pesa payments')}</CardTitle>
            <CardDescription>
              {t('Payments received on your M-Pesa short code')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MpesaTransactions />
          </CardContent>
        </Card>
        {store.user.isAdministrator ? <MpesaConfiguration /> : null}
      </div>
    </Page>
  );
}

export default withAuthentication(MpesaSettings);
