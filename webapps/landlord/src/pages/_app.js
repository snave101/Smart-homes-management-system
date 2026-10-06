import '../styles/globals.css';
import 'moment/locale/fr';
import 'moment/locale/pt';
import 'moment/locale/de';
import 'moment/locale/es';
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
import 'react-awesome-lightbox/build/style.css';
import '../components/PdfViewer/pdfviewer.css';
import '../components/RichTextEditor/richtexteditor.css';

import * as Yup from 'yup';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Application from '../components/Application';
import config from '../config';
import CssBaseline from '@material-ui/core/CssBaseline';
import Head from 'next/head';
import { InjectStoreContext } from '../store';
import moment from 'moment';
import { Roboto } from 'next/font/google';
import theme from '../styles/theme';
import { ThemeProvider } from '@material-ui/core/styles';
import { useEffect } from 'react';

const queryClient = new QueryClient();

const APP_TITLE = [config.APP_NAME, 'Landlord'];
if (config.NODE_ENV === 'development') {
  APP_TITLE.push('DEV');
} else if (config.DEMO_MODE) {
  APP_TITLE.push('DEMO');
}

Yup.addMethod(Yup.string, 'emails', function (message) {
  return this.test({
    name: 'emails',
    message: message || '${path} one of the emails is invalid or is not unique',
    test: (value) => {
      if (value == null) {
        return true;
      }
      const schema = Yup.string().email();
      const emails = value.replace(/\s/g, '').split(',');
      return (
        emails.every((email) => schema.isValidSync(email)) &&
        emails.length === new Set(emails).size
      );
    }
  });
});

const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  display: 'swap',
  subsets: ['latin', 'latin-ext']
});

function MyApp(props) {
  const { Component, pageProps } = props;
  moment.locale(pageProps?.__lang ?? 'en');

  useEffect(() => {
    // Remove the server-side injected CSS.
    const jssStyles = document.querySelector('#jss-server-side');
    if (jssStyles) {
      jssStyles.parentElement.removeChild(jssStyles);
    }
  }, []);

  useEffect(() => {
    // makes the app installable; only works over https or on localhost
    if ('serviceWorker' in navigator && config.NODE_ENV !== 'development') {
      navigator.serviceWorker
        .register(`${config.BASE_PATH}/sw.js`, {
          scope: `${config.BASE_PATH}/`
        })
        .catch((error) => console.warn('service worker not registered', error));
    }
  }, []);

  return (
    <>
      <Head>
        <title>{APP_TITLE.join(' - ')}</title>
        {/* PWA primary color */}
        <meta name="theme-color" content={theme.palette.primary.main} />
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width"
        />
        <link rel="shortcut icon" href={`${config.BASE_PATH}/favicon.svg`} />
        {/* installable web app */}
        <link
          rel="manifest"
          href={`${config.BASE_PATH}/manifest.webmanifest`}
        />
        <link
          rel="apple-touch-icon"
          href={`${config.BASE_PATH}/icons/apple-touch-icon.png`}
        />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </Head>
      <main className={roboto.className}>
        <ThemeProvider theme={theme}>
          {/* CssBaseline kickstart an elegant, consistent, and simple baseline to build upon. */}
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <InjectStoreContext initialData={pageProps.initialState?.store}>
              <Application {...pageProps}>
                <Component {...pageProps} />
              </Application>
            </InjectStoreContext>
          </QueryClientProvider>
        </ThemeProvider>
      </main>
    </>
  );
}

export default MyApp;
