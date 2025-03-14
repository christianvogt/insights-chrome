import { isBeta, isValidAccountNumber, pageAllowsUnentitled } from '../utils/common';
import servicesApi from './entitlements';
import logger from './logger';
import { SSOParsedToken } from './Priv';
import { ChromeUser } from '@redhat-cloud-services/types';
import { isAnsibleTrialFlagActive } from '../utils/isAnsibleTrialFlagActive';
import chromeHistory from '../utils/chromeHistory';

export type SSOServiceDetails = {
  is_entitled: boolean;
  is_trial: boolean;
};

const log = logger('insights/user.js');
const pathMapper = {
  'cost-management': 'cost_management',
  insights: 'insights',
  openshift: 'openshift',
  migrations: 'migrations',
  ansible: 'ansible',
  subscriptions: 'subscriptions',
  settings: 'settings',
  'user-preferences': 'user_preferences',
  internal: 'internal',
};

const REDIRECT_BASE = `${document.location.origin}${isBeta() ? '/beta/' : '/'}`;

const unentitledPathMapper = (section: string, service: string, expired = false) =>
  ({
    ansible: `${REDIRECT_BASE}ansible/ansible-dashboard/${expired ? 'trial/expired' : 'trial'}`,
  }[section] || `${REDIRECT_BASE}?not_entitled=${service}`);

function getWindow() {
  return window;
}

/* eslint-disable camelcase */
export function buildUser(token: SSOParsedToken) {
  const user = token
    ? {
        identity: {
          account_number: token.account_number,
          org_id: token.org_id,
          type: token.type,
          ...(token.idp && { idp: token.idp }),
          user: {
            username: token.username,
            email: token.email,
            first_name: token.first_name,
            last_name: token.last_name,
            is_active: token.is_active,
            is_org_admin: token.is_org_admin,
            is_internal: token.is_internal,
            locale: token.locale,
          },
          internal: {
            org_id: token.org_id,
            account_id: token.account_id,
          },
        },
      }
    : null;

  return user;
}
/* eslint-enable camelcase */

export function tryBounceIfUnentitled(
  data:
    | boolean
    | {
        [key: string]: SSOServiceDetails;
      },
  section: string
) {
  // only test this on the apps that are in valid sections
  // we need to keep /apps and other things functional
  if (
    section !== 'insights' &&
    section !== 'openshift' &&
    section !== 'cost-management' &&
    section !== 'migrations' &&
    section !== 'ansible' &&
    section !== 'subscriptions' &&
    section !== 'settings' &&
    section !== 'user-preferences' &&
    section !== 'internal'
  ) {
    return;
  }

  const ansibleActive = isAnsibleTrialFlagActive();
  // test temporary ansible trial flag
  if (section === 'ansible' && ansibleActive) {
    return;
  }

  const service = pathMapper[section];
  // ansibleActive can be true/false/undefined
  const redirectAddress = unentitledPathMapper(section, service, ansibleActive === false);

  if (data === true) {
    // this is a force bounce scenario!
    getWindow().location.replace(redirectAddress);
  }

  if (section && typeof data === 'object') {
    if (data?.[service]?.is_entitled) {
      log(`Entitled to: ${service}`);
    } else {
      log(`Not entitled to: ${service}`);
      try {
        const url = new URL(redirectAddress);
        chromeHistory.replace({
          pathname: url.pathname,
          search: url.search,
        });
      } catch (error) {
        console.error(error);
        // if something goes wring with the redirect, use standard API
        getWindow().location.replace(redirectAddress);
      }
    }
  }
}

export default async (token: SSOParsedToken): Promise<ChromeUser | void> => {
  const user = buildUser(token);

  const pathName = getWindow().location.pathname.split('/');
  pathName.shift();
  if (pathName[0] === 'beta') {
    pathName.shift();
  }
  if (pathName?.[1] === 'subscriptions' || pathName?.[1] === 'cost-management') {
    pathName.shift();
  }

  if (user) {
    log(`Account Number: ${user.identity.account_number}`);
    let data: {
      [key: string]: {
        is_entitled: boolean;
        is_trial: boolean;
      };
    } = {};
    try {
      if (user.identity.account_number) {
        data = (await servicesApi(token.jti).servicesGet()) as unknown as typeof data;
      } else {
        console.log('Cannot call entitlements API, no account number');
      }
    } catch {
      // let's swallow error from services API
    }

    // NOTE: Openshift supports Users with Account Number of -1
    // thus we need to bypass here
    // call entitlements on / /beta /openshift or /beta/openshift,
    // but swallow error
    //
    // Landing Page *does* support accounts with -1
    // it has to
    if (pageAllowsUnentitled()) {
      return {
        ...user,
        entitlements: data,
      };
    }

    // Important this has to come after the above -1 allow checks
    // Otherwise we get bounced on those paths
    //
    // It also needs to not go int he servicesApi call
    // because 3scale 403s if the Account number is -1
    //
    // we "force" a bounce here because the entitlements API
    // was never called
    if (!isValidAccountNumber(user.identity.account_number)) {
      tryBounceIfUnentitled(true, pathName[0]);
      return;
    }

    tryBounceIfUnentitled(data as unknown as { [key: string]: SSOServiceDetails }, pathName[0]);

    return {
      ...user,
      entitlements: data,
    };
  } else {
    log('User not ready');
  }
};
