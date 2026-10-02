import {
  allocateMpesaTransaction,
  changeMpesaTransaction,
  fetchMpesaTransactions,
  fetchTenants,
  QueryKeys
} from '../../utils/restcalls';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../ui/table';
import { useContext, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import Loading from '../Loading';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { StoreContext } from '../../store';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';

function errorMessage(error, fallback) {
  return error?.response?.data?.message || fallback;
}

function StatusBadge({ transaction }) {
  const { t } = useTranslation('common');
  const reasons = {
    unknown_account: t('Unknown account number'),
    ambiguous_account: t('Account number shared by several tenants'),
    no_rent: t('The tenant has no rent'),
    integration_disabled: t('Received while M-Pesa was turned off'),
    apply_failed: t('Could not be recorded'),
    detached: t('Removed from the rent')
  };

  switch (transaction.status) {
    case 'matched':
      return <Badge variant="success">{t('Recorded')}</Badge>;
    case 'ignored':
      return <Badge variant="secondary">{t('Ignored')}</Badge>;
    case 'received':
      return <Badge variant="outline">{t('Processing')}</Badge>;
    default:
      return (
        <div className="flex flex-col items-start gap-1">
          <Badge variant="destructive">{t('To allocate')}</Badge>
          {reasons[transaction.reason] ? (
            <span className="text-xs text-muted-foreground">
              {reasons[transaction.reason]}
            </span>
          ) : null}
        </div>
      );
  }
}

function TransactionActions({ transaction, tenants, onChanged }) {
  const { t } = useTranslation('common');
  const [tenantId, setTenantId] = useState('');
  const onError = (error) =>
    toast.error(errorMessage(error, t('Something went wrong')));

  const allocate = useMutation({
    mutationFn: allocateMpesaTransaction,
    onSuccess: () => {
      setTenantId('');
      onChanged(true);
    },
    onError
  });
  const change = useMutation({
    mutationFn: changeMpesaTransaction,
    onSuccess: (data, { action }) => onChanged(action === 'detach'),
    onError
  });
  const busy = allocate.isPending || change.isPending;
  const id = transaction._id;

  if (transaction.status === 'matched') {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => change.mutate({ id, action: 'detach' })}
      >
        {t('Remove from the rent')}
      </Button>
    );
  }

  if (transaction.status === 'ignored') {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => change.mutate({ id, action: 'restore' })}
      >
        {t('Restore')}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t('Tenant')}
        className="h-9 max-w-52 rounded-md border border-input bg-background px-2 text-sm"
        value={tenantId}
        disabled={busy}
        onChange={(event) => setTenantId(event.target.value)}
      >
        <option value="">{t('Choose a tenant')}</option>
        {tenants.map(({ _id, name, reference }) => (
          <option key={_id} value={_id}>
            {reference ? `${name} (${reference})` : name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={busy || !tenantId}
        onClick={() => allocate.mutate({ id, tenantId })}
      >
        {t('Record on the rent')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => change.mutate({ id, action: 'ignore' })}
      >
        {t('Ignore')}
      </Button>
    </div>
  );
}

export default function MpesaTransactions() {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: [QueryKeys.MPESA_TRANSACTIONS],
    queryFn: fetchMpesaTransactions,
    refetchInterval: 60000
  });
  const { data: tenantList } = useQuery({
    queryKey: [QueryKeys.TENANTS],
    queryFn: () => fetchTenants(store)
  });

  const tenants = useMemo(
    () =>
      [...(tenantList || [])].sort((t1, t2) =>
        String(t1.name).localeCompare(String(t2.name))
      ),
    [tenantList]
  );

  const handleChanged = (rentsChanged) => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.MPESA_TRANSACTIONS] });
    if (rentsChanged) {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.RENTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.TENANTS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DASHBOARD] });
    }
  };

  if (isLoading) {
    return <Loading fullScreen={false} />;
  }

  if (isError) {
    return (
      <div className="text-sm text-destructive">
        {t('Error fetching the M-Pesa payments')}
      </div>
    );
  }

  const transactions = data?.transactions || [];
  const toAllocate = data?.counts?.unmatched || 0;

  if (!transactions.length) {
    return (
      <div className="text-sm text-muted-foreground">
        {t('No M-Pesa payment received yet')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {toAllocate > 0 ? (
        <div className="text-sm text-destructive">
          {t('{{number}} payment(s) could not be matched to a tenant', {
            number: toAllocate
          })}
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Date')}</TableHead>
            <TableHead>{t('Receipt')}</TableHead>
            <TableHead>{t('Paid by')}</TableHead>
            <TableHead>{t('Account number')}</TableHead>
            <TableHead className="text-right">{t('Amount')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead>{t('Tenant')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((transaction) => (
            <TableRow key={transaction._id}>
              <TableCell className="whitespace-nowrap">
                {moment(transaction.paidAt).format('L LT')}
              </TableCell>
              <TableCell className="font-mono">{transaction.transId}</TableCell>
              <TableCell>{transaction.payerName || '-'}</TableCell>
              <TableCell>{transaction.billRefNumber || '-'}</TableCell>
              <TableCell className="text-right">
                <NumberFormat value={transaction.amount} />
              </TableCell>
              <TableCell>
                <StatusBadge transaction={transaction} />
              </TableCell>
              <TableCell>
                {transaction.tenantName ? (
                  <div className="flex flex-col">
                    <span>{transaction.tenantName}</span>
                    {transaction.term ? (
                      <span className="text-xs text-muted-foreground">
                        {moment(String(transaction.term), 'YYYYMMDDHH').format(
                          'MMMM YYYY'
                        )}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  '-'
                )}
              </TableCell>
              <TableCell>
                <TransactionActions
                  transaction={transaction}
                  tenants={tenants}
                  onChanged={handleChanged}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
