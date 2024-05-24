import "./lib/jszip.min.js";
import { TurndownService } from "./lib/turndown.js";
import { TurndownPluginGfmService } from "./lib/turndown-plugin-gfm.js";
import "./lib/js-yaml.min.js";
import replaceAsync from "./lib/string-replace-async.js";
import * as MOD_CONFIG from "./config.js";
import { myRenderTemplate, clearTemplateCache } from "./render-template.js"

const MODULE_NAME = "export-markdown";
const FRONTMATTER = "---\n";
const EOL = "\n";
const MARKER = "```";

const destForImages = "zz_asset-files";

let zip;

const IMG_SIZE = "150";
const ITEM_BREAK = "ITEMS";
export const SORT_DEFAULT = 100;

// The number of characters to use in the sort.
// This needs to be big enough so that each level sorts properly.
export const SORT_PADDING = 10;

let use_uuid_for_journal_folder=true;
let use_uuid_for_notename=true;

class DOCUMENT_ICON {
    // indexed by CONST.DOCUMENT_TYPES
    static table = {
        Actor: ":user:",
        Cards: ":spade:",
        ChatMessage: ":messages-square:",
        Combat: ":swords:",
        Item: ":luggage:",
        Folder: ":folder:",
        JournalEntry: ":book:",
        JournalEntryPage: ":sticky-note:",   // my own addition
        //Macro: "",
        Playlist: ":music:",
        RollTable: ":list:",
        Scene: ":map:"
    };

    //User: ""
    static lookup(document) {
        return DOCUMENT_ICON.table?.[document.documentName] || ":file-question:";
    }
}

/**
 * 
 * @param {Object} from Either a folder or a Journal, selected from the sidebar
 */

export function validFilename(name) {
    const regexp = /[<>:"/\\|?*]/g;
    return name.replaceAll(regexp, '_');
}

function docfilename(doc) {
    // If doc is actually a CompendiumCollection use it's title rather than name.
    if(doc instanceof CompendiumCollection) {
        return use_uuid_for_notename ? doc.uuid : validFilename(doc.title);
    } else {
        return use_uuid_for_notename ? doc.uuid : validFilename(doc.name);
    }
}

function zipfilename(doc) {
    return `${docfilename(doc)}.md`;
}

function formpath(dir,file) {
    return dir ? (dir + "/" + file) : file;
}

function templateFile(doc) {
    // Look for a specific template, otherwise use the generic template
    let base = (doc instanceof Actor) ? "Actor" : (doc instanceof Item) ? "Item" : undefined;
    if (!base) return undefined;
    return game.settings.get(MODULE_NAME, `template.${base}.${doc.type}`) || game.settings.get(MODULE_NAME, `template.${base}`);
}

/**
 * Export data content to be saved to a local file
 * @param {string} blob       The Blob of data
 * @param {string} filename   The filename of the resulting download
 */
function saveDataToFile(blob, filename) {
    // Create an element to trigger the download
    let a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = filename;

    // Dispatch a click event to the element
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return new Promise(resolve => setTimeout(() => { window.URL.revokeObjectURL(a.href); resolve()}, 100));
}

function folderpath(doc) {
    let result = "";
    let folder = doc.folder;
    while (folder) {
        const foldername = validFilename(folder.name);
        result = result ? formpath(foldername, result) : foldername;
        folder = folder.folder;
    }
    return result;
}

function formatLink(link, label=null, inline=false) {
    let body = link;
    if (label && label != link) body += `|${label}`;
    let result = `[[${body}]]`;
    if (inline) result = "!" + result;
    return result;
}

export function fileconvert(filename, label_or_size=null, inline=true) {
    filename = decodeURIComponent(filename);
    //let basefilename = filename.slice(filename.lastIndexOf("/") + 1);
    // ensure same base filename in different paths are stored as different files,
    // whilst keeping the total length below the ZIP limit of 260 characters.
    let basefilename = filename.replaceAll("/","-").slice(-250 + destForImages.length); 

    zip.folder(destForImages).file(basefilename, 
        // Provide a Promise which JSZIP will wait for before saving the file.
        // (Note that a CORS request will fail at this point.)
        fetch(filename).then(resp => {
            if (resp.status !== 200) {
                console.error(`Failed to fetch file from '${filename}' (response ${resp.status})`)
                return new Blob();
            } else {
                console.debug(`Adding file ${basefilename}`);
                return resp.blob();
            }
        }).catch(e => { 
            console.log(e);
            return new Blob();
        }),
    {binary:true});

    return formatLink(basefilename, label_or_size, inline);
}

function replaceLinkedFile(str, filename) {
    // For use by String().replaceAll,
    // Ensure we DON'T set the third parameter from a markdown link
    // See if we can grab the file.
    //console.log(`fileconvert for '${filename}'`);
    if (filename.startsWith("data:image") || filename.startsWith(":")) {
        // e.g.
        // http://URL
        // https://URL
        // data:image;inline binary
        console.log(`Ignoring file/external URL in '${str}':\n${filename}`);
        return str;
    }
    return fileconvert(filename);
}

function notefilename(doc) {
    return docfilename((doc instanceof JournalEntryPage && doc.parent.pages.size === 1) ? doc.parent : doc);
}

let turndownService, gfm;

// This is function is used in pf2e-md-exporter as a part of removing async functions used in handlebar helpers.
function uuidFailSafe(target, label) {
    if (!use_uuid_for_notename) {
        // Foundry's fromUuidSync() will thrown an error if the UUID 
        // document is only available via an async operation.
        // We can't resolve async function calls via a handlebar, so let's try another approach...
        
        // I discovered this function mentioned in foundry.js:
        // let {collection, documentId, documentType, embedded, doc} = foundry.utils.parseUuid(target);

        // Get the UUID parts for the target - that can always be done synchronously.
        let uuidParts = foundry.utils.parseUuid(target);

        // Using the UUID parts information from the target, get the UUID of the target's parent
        try {
            let parentUuid = uuidParts.collection.getUuid(uuidParts.documentId);
            
            // Now that we have the parent's UUID, get it in document form.
            // In testing, it appears the parent can be fetched via a synchronoous operation, which is what we need.
            let parentDoc = fromUuidSync(parentUuid);
                // Lookup the friendly name of the path, so we can use it as a prefix for the link to make it more unique.
            if (parentDoc) {
                let pack = game.packs.get(parentDoc.pack);
                if (pack) {
                    // Slashes in the title aren't real paths and as part of the export become underscores
                    let fixed_title = pack.title.replaceAll('/', '_');
                    let result = `${fixed_title}/${parentDoc.name}/${label}`;
                    return formatLink(result, label, /*inline*/false);
                }
            }
        }
        catch (error) {
            console.error(error);
        }
        console.log("Ooops.... we fell through.  Unresolved URL: ", target);
    }
    return dummyLink(target, label);
}

function dummyLink(target, label) {
    // Make sure that "|" in the ID don't start the label early (e.g. @PDF[whatever|page=name]{label})
    return formatLink(target, label);
}

function convertLinks(markdown, relativeTo) {

    // Needs to be nested so that we have access to 'relativeTo'
    function replaceOneLink(str, type, target, hash, label, offset, string, groups) {

        // One of my Foundry Modules introduced adding "inline" to the start of type.
        let inline = type.startsWith("inline");
        if (inline) type = type.slice("inline".length);
        // Maybe handle `@PDF` links properly too

        // Ignore link if it isn't one that we can parse.
        const documentTypes = new Set(CONST.DOCUMENT_LINK_TYPES.concat(["Compendium", "UUID"]));
        if (!documentTypes.has(type)) return str;
        
        // Ensure the target is in a UUID format.
        if (type !== "UUID") target = `${type}.${target}`

        let linkdoc;
        try {
            linkdoc = fromUuidSync(target, {relative: relativeTo});
            if (!label && !hash) label = linkdoc.name;
        } catch (error) {
            //console.debug(`Unable to fetch label from Compendium for ${target}`, error)
            return uuidFailSafe(target, label);
        }

        if (!linkdoc) return dummyLink(target, label);
        
        // A journal with only one page is put into a Note using the name of the Journal, not the only Page.
        let filename = notefilename(linkdoc);
    
        // FOUNDRY uses slugified section names, rather than the actual text of the HTML header.
        // So we need to look up the slug in the Journal Page's TOC.
        let result = filename;
        if (hash && linkdoc instanceof JournalEntryPage) {
            const toc = linkdoc.toc;
            if (toc[hash]) {
                result += `#${toc[hash].text}`;
                if (!label) label = toc[hash].text;
            }
        }
        return formatLink(result, label, /*inline*/false);  // TODO: maybe pass inline if we really want inline inclusion
    }
    
    // Convert all the links
    const pattern = /@([A-Za-z]+)\[([^#\]]+)(?:#([^\]]+))?](?:{([^}]+)})?/g;
    markdown = markdown.replace(pattern, replaceOneLink);
    // Replace file references (TBD AFTER HTML conversion)
    const filepattern = /!\[\]\(([^)]*)\)/g;
    markdown = markdown.replaceAll(filepattern, replaceLinkedFile);
    return markdown;
}

export function convertHtml(doc, html) {
    // Foundry uses "showdown" rather than "turndown":
    // SHOWDOWN fails to parse tables at all

    if (!turndownService) {
        // Setup Turndown service to use GFM for tables
        // headingStyle: "atx"  <-- use "###" to indicate heading (whereas setext uses === or --- to underline headings)
        turndownService = new TurndownService({ 
            headingStyle: "atx",
            codeBlockStyle: "fenced"
        });
        // GFM provides supports for strikethrough, tables, taskListItems, highlightedCodeBlock
        gfm = TurndownPluginGfmService.gfm;
        turndownService.use(gfm);
    }
    let markdown;
    try {
        // Convert links BEFORE doing HTML->MARKDOWN (to get links inside tables working properly)
        // The conversion "escapes" the "[[...]]" markers, so we have to remove those markers afterwards
        markdown = turndownService.turndown((convertLinks(html, doc))).replaceAll("\\[\\[","[[").replaceAll("\\]\\]","]]");
        // Now convert file references
        const filepattern = /!\[\]\(([^)]*)\)/g;
        markdown = markdown.replaceAll(filepattern, replaceLinkedFile);    
    } catch (error) {
        console.warn(`Error: failed to decode html:`, html)
    }
    return markdown;
}

function convertPage (page) {
    let markdown;
    switch (page.type) {
        case "text":
            switch (page.text.format) {
                case 1: // HTML
                    markdown = convertHtml(page, page.text.content);
                    break;
                case 2: // MARKDOWN
                    markdown = page.text.markdown;
                    break;
            }
            break;
        case "image": case "pdf": case "video":
            if (page.src) markdown = fileconvert(page.src) + EOL;
            if (page.image?.caption) markdown += EOL + page.image.caption + EOL;
            break;
    }
    return markdown;
}

function frontmatter(doc, sort=SORT_DEFAULT, showheader=true, index=false) {
    let header = showheader ? `\n# ${doc.name}\n` : "";
    let sortFormated = sort.toString().padStart(SORT_PADDING,'0');
    let title = index ? "Index of " + doc.name : doc.name;
    return FRONTMATTER + 
        `title: "${title}"\n` + 
        `icon: "${DOCUMENT_ICON.lookup(doc)}"\n` +
        `aliases: "${title}"\n` + 
        `foundryId: ${doc.uuid}\n` + 
        `sortOrder: "${sortFormated}"\n` + 
        `tags:\n  - ${doc.documentName}\n` +
        FRONTMATTER +
        header;
}

function frontmatterFolder(name, sort=SORT_DEFAULT, showheader=true, index=false) {
    let header = showheader ? `\n# ${name}\n` : "";
    let sortFormated = sort.toString().padStart(SORT_PADDING,'0');
    let title = index ? "Index of " + name : name;
    return FRONTMATTER + 
        `title: "${title}"\n` + 
        `icon: ":folder:"\n` +
        `aliases: "${title}"\n` +
        `sortOrder: "${sortFormated}"\n` +  
        `tags:\n  - "toc"\n` +
        FRONTMATTER +
        header;
}

async function oneJournal(path, journal, sort=SORT_DEFAULT) {
    let subpath = path;
    const pages = journal.pages.contents;
    if (journal.pages.size > 1) {
        // Put all the notes in a sub-folder
        subpath = formpath(path, use_uuid_for_journal_folder ? docfilename(journal) : validFilename(journal.name));
        // TOC page 
        // This is a Folder note, so goes INSIDE the folder for this journal entry
        let markdown = frontmatter(journal, sort, true, false);
        if (pages.find(page => page.name === journal.name)) {
            markdown += "\n" + convertPage(pages.find(page => page.name === journal.name)) + "\n\n---\n";
        }
        markdown += "\n## Table of Contents\n";
        for (let page of pages.sort((a,b) => a.sort - b.sort)) {
            // Rename page note if it already exists in the zip file.
            let name = journal.name == page.name ? page.name + " " + 1 : page.name;
            markdown += `\n${' '.repeat(2*(page.title.level-1))}- ${formatLink(docfilename(page), page.name)}`;
        }
        // Filename must match the folder name
        const tocName = use_uuid_for_journal_folder ? zipfilename(journal) : zipfilename(journal);
        zip.folder(subpath).file(tocName, markdown, { binary: false });
    }

    let subsort = journal.pages.size > 1 ? sort * 10 : sort;
    for (const page of pages.sort((a,b) => a.sort - b.sort)) {
        // If the page is the Folder Note, skip it since it was alread processed.
        if(page.name != journal.name || journal.pages.size == 1) {
            // Rename page note if it already exists in the zip file but isn't the Folder Note.
            let i = 1;
            let name =  notefilename(page);
            while (`${subpath}/${name}.md` in zip.files) {
                name = notefilename(page) + " " + i;
            }
            let markdown = convertPage(page);
            if (markdown) {
                markdown = frontmatter(page, subsort, page.title.show) + markdown;
                
                zip.folder(subpath).file(`${name}.md`, markdown, { binary: false });
            }
            subsort += 1;
        }
    }
}

async function oneRollTable(path, table, sort=SORT_DEFAULT) {
    let markdown = frontmatter(table, sort);
    
    if (table.description) markdown += table.description + "\n\n";

    markdown += 
        `| ${table.formula || "Roll"} | result |\n` +
        `|------|--------|\n`;

    for (const tableresult of table.results) {
        const range  = (tableresult.range[0] == tableresult.range[1]) ? tableresult.range[0] : `${tableresult.range[0]}-${tableresult.range[1]}`;
        // Escape the "|" in any links
        markdown += `| ${range} | ${(convertLinks(tableresult.getChatText(), table)).replaceAll("|","\\|")} |\n`;
    }

    // No path for tables
    zip.folder(path).file(zipfilename(table), markdown, { binary: false });
}

function oneScene(path, scene, sort=SORT_DEFAULT) {

    const sceneBottom = scene.dimensions.sceneRect.bottom;
    const sceneLeft   = scene.dimensions.sceneRect.left;
    const units_per_pixel = /*units*/ scene.grid.distance / /*pixels*/ scene.grid.size;

    function coord(pixels) {
        return pixels * units_per_pixel;
    }
    function coord2(pixely, pixelx) { return `${coord(sceneBottom - pixely)}, ${coord(pixelx - sceneLeft)}` };

    let markdown = frontmatter(scene, sort);

    // Two "image:" lines just appear as separate layers in leaflet.
    let overlays=[]
    if (scene.foreground) {
        overlays.push(`${fileconvert(scene.foreground, "Foreground", /*inline*/false)}`);
    }

    for (const tile of scene.tiles) {
        // tile.overhead
        // tile.roof
        // tile.hidden
        // tile.z
        // tile.alpha
        // - [ [[ImageFile2|Optional Alias]], [Top Left Coordinates], [Bottom Right Coordinates] ]
        let name = tile.texture.src;
        let pos = name.lastIndexOf('/');
        if (pos) name = name.slice(pos+1);
        overlays.push(`${fileconvert(tile.texture.src, name, /*inline*/ false)}, [${coord2(tile.y+tile.height-1, tile.x)}], [${coord2(tile.y, tile.x+tile.width-1)}]`);
    }

    let layers = (overlays.length === 0) ? "" : 'imageOverlay:\n' + overlays.map(layer => `    - [ ${layer} ]\n`).join("");
    // scene.navName - maybe an alias in the frontmatter (if non-empty, and different from scene.name)
    markdown += 
        `\n${MARKER}leaflet\n` +
        `id: ${scene.uuid}\n` +
        `bounds:\n    - [0, 0]\n    - [${coord(scene.dimensions.sceneRect.height)}, ${coord(scene.dimensions.sceneRect.width)}]\n` +
        "defaultZoom: 2\n" +
        `lat: ${coord(scene.dimensions.sceneRect.height/2)}\n` +
        `long: ${coord(scene.dimensions.sceneRect.width/2)}\n` +
        `height: 100%\n` +
        `draw: false\n` +
        `unit: ${scene.grid.units}\n` +
        `showAllMarkers: true\n` +
        `preserveAspect: true\n` +
        `image: ${fileconvert(scene.background.src, null, /*inline*/false)}\n` +
        layers;

    // scene.dimensions.distance / distancePixels / height / maxR / ratio
    // scene.dimensions.rect: (x, y, width, height, type:1)
    // scene.dimensions.sceneHeight/sceneWidth/size/height/width
    // scene.grid: { alpha: 0.2, color: "#000000", distance: 5, size: 150, type: 1, units: "ft"}
    // scene.height/width

    for (const note of scene.notes) {
        const linkdoc = note.page || note.entry;
        const linkfile = linkdoc ? notefilename(linkdoc) : "Not Linked";
        // Leaflet plugin doesn't like ":" appearsing in the Note's label.
        const label = note.label.replaceAll(":","_");

        // invert Y coordinate, and remove the padding from the note's X,Y position
        markdown += `marker: default, ${coord2(note.y, note.x)}, ${formatLink(linkfile, label)}\n`;
            //`    icon: :${note.texture.src}:` + EOL +
    }
    markdown += MARKER;

    // scene.lights?

    zip.folder(path).file(zipfilename(scene), markdown, { binary: false });
}

function onePlaylist(path, playlist, sort=SORT_DEFAULT) {
    // playlist.description
    // playlist.fade
    // playlist.mode
    // playlist.name
    // playlist.seed
    // playlist._playbackOrder (array, containing list of keys into playlist.sounds)
    // playlist.sounds (collection of PlaylistSound)
    //    - debounceVolume
    //    - description
    //    - fade
    //    - name
    //    - path (filename)
    //    - pausedTime
    //    - repeat (bool)
    //    - volume

    let markdown = frontmatter(playlist, sort);

    if (playlist.description) markdown += playlist.description + EOL + EOL;

    for (const id of playlist._playbackOrder) {
        const sound = playlist.sounds.get(id);
        // HOW to encode volume of each track?
        markdown += `#### ${sound.name}` + EOL;
        if (sound.description) markdown += sound.description + EOL
        markdown += fileconvert(sound.path) + EOL;
    }

    zip.folder(path).file(zipfilename(playlist), markdown, { binary: false });
}

async function documentToJSON(path, doc, sort=SORT_DEFAULT) {
    // see Foundry exportToJSON

    const data = doc.toCompendium(null);
    // Remove things the user is unlikely to need
    if (data.prototypeToken) delete data.prototypeToken;

    let markdown = frontmatter(doc, sort);
    if (doc.img) markdown += fileconvert(doc.img, IMG_SIZE) + EOL + EOL;

    // Some common locations for descriptions
    const DESCRIPTIONS = [
        "system.details.biography.value",  // Actor: DND5E
        "system.details.publicNotes",       // Actor: PF2E
        "system.description.value",        // Item: DND5E and PF2E
    ]
    for (const field of DESCRIPTIONS) {
        let text = foundry.utils.getProperty(doc, field);
        if (text) markdown += convertHtml(doc, text) + EOL + EOL;
    }

    let datastring;
    let dumpoption = game.settings.get(MOD_CONFIG.MODULE_NAME, MOD_CONFIG.OPTION_DUMP);
    if (dumpoption === "YAML")
        datastring = jsyaml.dump(data);
    else if (dumpoption === "JSON")
        datastring = JSON.stringify(data, null, 2) + EOL;
    else
        console.error(`Unknown option for dumping objects: ${dumpoption}`)
    // TODO: maybe extract Items as separate notes?

    // Convert LINKS: Foundry syntax to Markdown syntax
    datastring = convertLinks(datastring, doc);

    markdown +=
        MARKER + doc.documentName + EOL + 
        datastring +
        MARKER + EOL;

    zip.folder(path).file(zipfilename(doc), markdown, { binary: false });
}

async function maybeTemplate(path, doc, sort=SORT_DEFAULT) {
    const templatePath = templateFile(doc);
    if (!templatePath) return documentToJSON(path, doc, sort);
    // console.log(`Using handlebars template '${templatePath}' for '${doc.name}'`)

    // Always upload the IMG, if present, but we won't include the corresponding markdown
    if (doc.img) fileconvert(doc.img, IMG_SIZE);

    // Apply the supplied template file:
    // Foundry renderTemplate only supports templates with file extensions: html, handlebars, hbs
    // Foundry filePicker hides all files with extension html, handlebars, hbs
    const markdown = await myRenderTemplate(templatePath, doc, sort).catch(err => {
        ui.notifications.warn(`Handlers Error: ${err.message}`);
        throw err;
    })

    zip.folder(path).file(zipfilename(doc), markdown, { binary: false });
}

async function oneDocument(path, doc, sort=SORT_DEFAULT) {
    if (doc instanceof JournalEntry)
        await oneJournal(path, doc, sort);
    else if (doc instanceof RollTable)
        await oneRollTable(path, doc, sort);
    else if (doc instanceof Scene && game.settings.get(MOD_CONFIG.MODULE_NAME, MOD_CONFIG.OPTION_LEAFLET))
        await oneScene(path, doc, sort);
    else if (doc instanceof Playlist)
        await onePlaylist(path, doc, sort);
    else
        await maybeTemplate(path, doc, sort);
    // Actor
    // Cards
    // ChatMessage
    // Combat(Tracker)
    // Item
    // Macro
}

async function oneChatMessage(path, message) {
    let html = await message.getHTML();
    if (!html?.length) return message.export();

    return `## ${new Date(message.timestamp).toLocaleString()}\n\n` + 
        convertHtml(message, html[0].outerHTML);
}

async function oneChatLog(path, chatlog) {
    // game.messages.export:
    // Messages.export()
    let log=""
    for (const message of chatlog.collection) {
        log += await oneChatMessage(path, message) + "\n\n---------------------------\n\n";
    }
    //const log = chatlog.collection.map(m => oneChatMessage(path, m)).join("\n---------------------------\n");
    let date = new Date().toDateString().replace(/\s/g, "-");
    const filename = `log-${date}.md`;

    zip.folder(path).file(filename, log, { binary: false });
}

async function oneFolder(path, folder, sort=SORT_DEFAULT) {
    let subpath = formpath(path, validFilename(folder.name));
    let toc = [];
    let subsort = sort * 10;
    for (const childfolder of folder.getSubfolders(/*recursive*/false)) {
        subsort += 1;
        await oneFolder(subpath, childfolder, subsort);
        toc.push(tocFolderLink(formpath(subpath, validFilename(childfolder.name)), childfolder, subsort));
    }
    const documents = folder.contents;
    if (toc.length > 0 && documents.length > 0) {
        toc.push(ITEM_BREAK);
    }
    for (const doc of documents.sort((a,b) => a.sort - b.sort)) {
        subsort += 1;
        await oneDocument(subpath, doc, subsort);
        toc.push(tocLink(subpath, doc));
    }
    if(toc.length > 0) {
        tableOfContents(subpath, folder.name, zipfilename(folder), toc, sort);
    }
}

async function onePack(path, pack, sort=SORT_DEFAULT) {
    let toc = [];
    let type = pack.metadata.type;
    console.debug(`Collecting pack '${pack.title}'`)
    let subpath = formpath(path, validFilename(pack.title));
    const documents = await pack.getDocuments();
    let folders = pack.folders;
    let subsort = sort * 10;
    let depth = 1;
    for (const folder of folders) {
        if(folder.depth == depth) {
            subsort += 1;
            toc.push(tocFolderLink(formpath(subpath, validFilename(folder.name)), folder, subsort));
        }
    }
    if (toc.length > 0 && documents.length > 0) {
        toc.push(ITEM_BREAK);
    }
    for (const doc of documents.sort((a,b) => a.sort - b.sort)) {
        if (!doc.folder) {
            subsort += 1;
            await oneDocument(subpath, doc, subsort);
            toc.push(tocLink(subpath, doc));
        }
    }
    if(toc.length > 0) {
        tableOfContents(subpath, pack.title, zipfilename(pack), toc, sort);
    }
    await compendiumFolders(subpath, folders, documents, depth, sort);
}

async function onePackFolder(path, folder, sort=SORT_DEFAULT) {
    let subpath = formpath(path, validFilename(folder.name));
    let subsort = sort * 10;
    for (const pack of game.packs.filter(pack => pack.folder === folder)) {
        subsort += 1;
        await onePack(subpath, pack, subsort);
    }
}

function tocLink (path, doc) {
    let docName;
    let subpath;
    if (doc instanceof JournalEntry && doc.pages.size > 1) {
        docName = doc.name;
        subpath = formpath(".", validFilename(doc.name));
    } else {
        docName = doc.name;
        subpath = ".";
    }
    const docPath = formpath(subpath, use_uuid_for_journal_folder ? docfilename(doc) : validFilename(docName));
    const docLink = formatLink(docPath, doc.name)
    return docLink;
}

function tocFolderLink (path, folder) {
    const name = folder.name;
    const folderPath = formpath(path, use_uuid_for_journal_folder ? docfilename(folder) : validFilename(folder.name));
    const folderLink = formatLink(folderPath, folder.name)
    return folderLink;
}

// Creat a Table Of Contents file given the path of the file, name of the file,
// and an array of links to include in the Table of Contents
async function tableOfContents (path, name, fileName, toc, sort=SORT_DEFAULT) {
    let markdown = frontmatterFolder(name, sort, true, false) + "\n## Table of Contents\n";
    for (const link of toc) {
        markdown += link != ITEM_BREAK ? `\n- ${link}` : '\n---';
    }
    zip.folder(path).file(fileName,  markdown, { binary: false });
}

async function compendiumFolders(path, folders, docs, depth, sort=SORT_DEFAULT) {
    let subsort = sort * 10;
    for (const folder of folders) {
        let toc = [];
        subsort += 1;
        if (folder instanceof Folder && typeof(folder.depth) != "undefined" && folder.depth === depth) {
            let subpath = formpath(path, validFilename(folder.name));

            let children = folder.children;
            if (children.length != 0) {
                let childFolders = [];
                for (const child of children) {
                    childFolders.push(child.folder);
                    toc.push(tocFolderLink(formpath(subpath, validFilename(child.folder.name)), child.folder));
                }
                await compendiumFolders(subpath, childFolders, docs, depth + 1, subsort);
                subsort += 1;
            }

            let contents = folder.contents;
            let subsubsort = subsort * 10;
            if (toc.length > 0 && contents.length > 0) {
               toc.push(ITEM_BREAK);
            }
            for (const item of contents.sort((a,b) => a.sort - b.sort)) {
                const doc = docs.find(({uuid}) => uuid === item.uuid);
                subsubsort += 1;
                if (doc) {
                    await oneDocument(subpath, doc, subsubsort);
                    toc.push(tocLink(subpath, doc));
                }
            }
            if(toc.length) {
                tableOfContents(subpath, folder.name, zipfilename(folder), toc, subsort);
            }
        }
    }
}

let is_v10=false

export async function exportMarkdown(from, zipname) {

    clearTemplateCache();

    use_uuid_for_journal_folder = game.settings.get(MOD_CONFIG.MODULE_NAME, MOD_CONFIG.OPTION_FOLDER_AS_UUID);
    use_uuid_for_notename       = game.settings.get(MOD_CONFIG.MODULE_NAME, MOD_CONFIG.OPTION_NOTENAME_IS_UUID);

    let noteid = ui.notifications.info(`${MODULE_NAME}.ProgressNotification`, {permanent: true, localize: true})
    // Wait for the notification to get drawn
    await new Promise(resolve => setTimeout(resolve, 100));

    zip = new JSZip();

    const TOP_PATH = "";
    let sort = 101;

    if (from instanceof Folder) {
        console.debug(`Processing one Folder`)
        // Do we put in the full hierarchy that might be ABOVE the indicated folder
        if (from.type === "Compendium")
            await onePackFolder(TOP_PATH, from, sort);
        else
            await oneFolder(TOP_PATH, from, sort);
    }
    else if (is_v10 ? from instanceof SidebarDirectory : from instanceof DocumentDirectory) {
        for (const doc of from.documents) {
            await oneDocument(folderpath(doc), doc, sort);
            sort += 1;
        }
    } 
    else if (from instanceof CompendiumDirectory) {
        // from.collection does not exist in V10
        for (const doc of game.packs) {
            await onePack(folderpath(doc), doc, sort);
            sort += 1;
        }
    } 
    else if (from instanceof CompendiumCollection) {
        await onePack(TOP_PATH, from, sort);
    } 
    else if (from instanceof CombatTracker) {
        for (const combat of from.combats) {
            await oneDocument(TOP_PATH, combat, sort);
            sort += 1;
        }
    }
    else if (from instanceof ChatLog) {
        await oneChatLog(from.title, from);
    } 
    else
        await oneDocument(TOP_PATH, from, sort);

    let blob = await zip.generateAsync({ type: "blob" });
    await saveDataToFile(blob, `${validFilename(zipname)}.zip`);
    // ui.notifications.remove does not exist in Foundry V10
    ui.notifications.remove?.(noteid);
}

function ziprawfilename(name, type) {
    if (!type) return name;
    return `${type}-${name}`;
}

Hooks.once('init', async () => {
    // Foundry V10 doesn't use DocumentDirectory
    is_v10 = (typeof DocumentDirectory === "undefined");

    // If not done during "init" hook, then the journal entry context menu doesn't work

    const baseClass = is_v10 ? "SidebarDirectory" : "DocumentDirectory";

    // JOURNAL ENTRY context menu
    function addEntryMenu(wrapped, ...args) {
        return wrapped(...args).concat({
            name: `${MODULE_NAME}.exportToMarkdown`,
            icon: '<i class="fas fa-file-zip"></i>',
            condition: () => game.user.isGM,
            callback: async header => {
                const li = header.closest(".directory-item");
                const id = li.data(is_v10 ? "documentId" : "entryId");
                const entry = this.documents.find(d => d.id === id);
                //const entry = this.collection.get(li.data("entryId")); // works only on V11+
                if (entry) exportMarkdown(entry, ziprawfilename(entry.name, entry.constructor.name));
            },
        });
    }
    libWrapper.register(MODULE_NAME, `${baseClass}.prototype._getEntryContextOptions`, addEntryMenu, libWrapper.WRAPPER);

    function addCompendiumEntryMenu(wrapped, ...args) {
        return wrapped(...args).concat({
            name: `${MODULE_NAME}.exportToMarkdown`,
            icon: '<i class="fas fa-file-zip"></i>',
            condition: () => game.user.isGM,
            callback: async li => {
                const pack = game.packs.get(li.data("pack"));
                if (pack) exportMarkdown(pack, ziprawfilename(pack.title, pack.metadata.type));
            },
        });
    }
    libWrapper.register(MODULE_NAME, "CompendiumDirectory.prototype._getEntryContextOptions", addCompendiumEntryMenu, libWrapper.WRAPPER);

    // FOLDER context menu: needs 
    function addFolderMenu(wrapped, ...args) {
        return wrapped(...args).concat({
            name: `${MODULE_NAME}.exportToMarkdown`,
            icon: '<i class="fas fa-file-zip"></i>',
            condition: () => game.user.isGM,
            callback: async header => {
                const li = header.closest(".directory-item")[0];
                // li.dataset.uuid does not exist in Foundry V10
                const folder = await fromUuid(`Folder.${li.dataset.folderId}`);
                if (folder) exportMarkdown(folder, ziprawfilename(folder.name, folder.type));
            },
        });
    }
    libWrapper.register(MODULE_NAME, `${baseClass}.prototype._getFolderContextOptions`, addFolderMenu, libWrapper.WRAPPER);
    if (!is_v10) libWrapper.register(MODULE_NAME, "CompendiumDirectory.prototype._getFolderContextOptions", addFolderMenu, libWrapper.WRAPPER);
})

Hooks.on("renderSidebarTab", async (app, html) => {
    if (!game.user.isGM) return;

    if (!(app instanceof Settings)) {
        const label = game.i18n.localize(`${MODULE_NAME}.exportToMarkdown`);
        const help  = game.i18n.localize(`${MODULE_NAME}.exportToMarkdownTooltip`);
        let button = $(`<button style="flex: 0" title="${help}"><i class='fas fa-file-zip'></i>${label}</button>`)
        button.click((event) => {
            event.preventDefault();
            exportMarkdown(app, ziprawfilename(app.constructor.name));
        });

        html.append(button);
    } else {
        console.debug(`Export-Markdown | Not adding button to sidebar`, app)
    }
})
