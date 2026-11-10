# EDOPro i18n

## How to use ?

Add in the `repos` array, in the `config/user_configs.json` in `EDOPro`:

```json
{
    "url": "https://github.com/FriquetLuca/edopro_i18n",
    "repo_name": "FriquetLuca EDOPro i18n",
    "repo_path": "./config/languages",
    "is_language": true,
    "language": "",
    "data_path": "",
    "should_update": true,
    "should_read": true
}
```

### At first launch
- Wait for the Multilanguage download update to finish. (Progress at the top left in the "**Repositories**" tab)
[![Repositories](https://puu.sh/FuSmK/479079320d.png)](#)
- **Relaunch** EDOPro and select your language in the options. (shortcut : **CTRL + O**)

### Common errors :

**Error: failed to stat '././config/languages'** : Delete languages folder in **ProjectIgnis\config** and relaunch.

### Credit :

- Français (strings.conf) : Hel (based on the work of LucienAclantis)

## Generator

The language generator is setup as a french translation generator, it might need a few tweaks to handle other languages. Feel free to open a PR for that.
