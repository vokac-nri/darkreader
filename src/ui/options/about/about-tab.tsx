import {m} from 'malevic';

import type {ViewProps} from '../../../definitions';
import {HELP_URL, HOMEPAGE_URL, PRIVACY_URL, getHelpURL} from '../../../utils/links';
import {getLocalMessage} from '../../../utils/locales';

import {AppVersion} from './version';

interface AboutTabProps {
    plus?: boolean;
}

export function AboutTab(props: ViewProps & AboutTabProps): Malevic.Child {
    return <div class="settings-tab about-tab">
        <AppVersion />
        <div>
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                Privacy Policy
            </a>
        </div>
        <div>
            <a href={`${HOMEPAGE_URL}/terms/`} target="_blank" rel="noopener noreferrer">
                Terms of Use
            </a>
        </div>
        <div>
            <a href={props.plus ? `${HELP_URL}/plus/` : getHelpURL()} target="_blank" rel="noopener noreferrer">{getLocalMessage('help')}</a>
        </div>
    </div>;
}
