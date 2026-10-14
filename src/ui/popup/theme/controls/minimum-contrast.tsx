import {m} from 'malevic';

import {getLocalMessage} from '../../../../utils/locales';
import {DropDown} from '../../../controls';
import type {DropDownOption} from '../../../controls/dropdown';

import ThemeControl from './theme-control';

export function getMinimumContrastOptions(): Array<DropDownOption<number>> {
    return [
        {id: 0, content: getLocalMessage('off')},
        {id: 3, content: '3:1'},
        {id: 4.5, content: '4.5:1'},
        {id: 7, content: '7:1'},
    ];
}

export default function MinimumContrast(props: {value: number; onChange: (value: number) => void}) {
    return (
        <ThemeControl label={getLocalMessage('minimum_contrast')}>
            <DropDown
                options={getMinimumContrastOptions()}
                onChange={props.onChange}
                selected={props.value}
            />
        </ThemeControl>
    );
}
