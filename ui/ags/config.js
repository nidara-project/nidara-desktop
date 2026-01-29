import App from 'resource:///com/github/Aylur/ags/app.js';
import { Dock } from './widgets/Dock.js';

export default {
    style: App.configDir + '/style.css',
    windows: [
        Dock()
    ],
};
