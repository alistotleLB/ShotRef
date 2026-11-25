// Every word a user sees in the two tours. Keyed by stop id (see the plan's stop ids).
// Voice rules: branding/BRAND.md section 2. Each stop body is at most 2 sentences.
export const TOUR_COPY = {
  ui: {
    next: 'Next',
    back: 'Back',
    end: 'End tour',
    finish: 'Finish',
    skip: 'Skip this step',
    busy: "Finish what you're doing first, then start the tour.",
    progress: (n, total) => `${n} of ${total}`,
  },

  // First-run window, shown before "Start a shot".
  welcome: {
    title: 'Take a look round the set?',
    body: 'Two short tours show you where everything is. Both are always in the Help menu if you want them later.',
    // while the hands-on tour is switched off (see handsTourOn in main.js)
    bodySolo: "A one-minute tour shows you where everything is. It's always in the Help menu if you want it later.",
    quick: 'Take the quick tour',
    hands: 'Try it hands-on',
    notNow: 'Not now',
  },

  // Gear menu heading and items (the desktop Help menu reuses quick and hands).
  menu: {
    heading: 'Help',
    quick: 'Take the quick tour',
    hands: 'Try it hands-on',
  },

  // Line at the top of the Quick start page.
  helpPage: {
    lead: 'Want a guided walk round the screen first?',
    quick: 'Take the quick tour',
    hands: 'Try it hands-on',
  },

  // Quick tour: look, no touching.
  basic: {
    'b-welcome': {
      title: 'A quick look round',
      text: 'This takes about a minute. Nothing here changes your scene.',
    },
    'b-steps': {
      title: 'The three steps',
      text: 'Work left to right: Build the scene, Frame the shot, then Export. The keys 1, 2 and 3 jump between them.',
    },
    'b-add': {
      title: 'The Add tab',
      text: 'People and props wait here, like a prop truck. Click one, then click the floor to place it.',
    },
    'b-picture': {
      title: 'The picture',
      text: 'Drag to orbit, right-drag to pan and scroll to zoom. Right-click anything for its menu.',
    },
    'b-view': {
      title: 'Three ways to look',
      text: 'Editor is your free view, Top is the floor plan and Camera is the shot itself. Split view shows Editor and Camera together.',
    },
    'b-panel': {
      title: 'The right-hand panel',
      text: 'It shows the settings for whatever you have selected. Click a person, the camera or nothing, and it changes to match.',
    },
    'b-timeline': {
      title: 'The timeline',
      text: 'Play the shot here and drag the playhead to any moment. Keyframes show as diamonds along it, and your shots are in the row above.',
    },
    'b-file': {
      title: 'The File menu',
      text: 'New, open, save and export all live here. Save here to keep a project file you can reopen.',
    },
    'b-gear': {
      title: 'Settings and help',
      text: 'Switch on Advanced controls for more detail, reopen the Quick start page or run these tours again.',
      textSolo: 'Switch on Advanced controls for more detail, reopen the Quick start page or take this tour again.',
    },
    'b-bye': {
      title: 'That is the lot',
      text: 'The hands-on tour has you try each part for real. Both tours are in the Help menu whenever you want them.',
      textSolo: 'You know where everything is now. The tour is in the Help menu whenever you want it again.',
    },
  },

  // Hands-on tour: do it. "done" shows with the tick on stops that wait for you.
  hands: {
    'h-welcome': {
      title: 'A practice stage',
      text: 'This is a practice stage. Your scene comes back when the tour ends.',
    },
    'h-build': {
      title: 'Start at Build',
      text: 'Click Build. This step is for placing people and props.',
      done: 'Opened',
    },
    'h-place': {
      title: 'Place a person',
      text: 'Click Man, Woman or Child, then click the floor. They stand on that spot, ready for blocking.',
      done: 'Placed',
    },
    'h-drag': {
      title: 'Move them',
      text: 'Drag the person to a new spot on the floor. This is blocking, the ShotRef way.',
      done: 'Moved',
    },
    'h-rightclick': {
      title: 'Right-click for options',
      text: 'Right-click the person to see what you can do with them. Press Esc to close the menu and stay in the tour.',
      done: 'Opened',
    },
    'h-scenetab': {
      title: 'The Items tab',
      text: 'Click Items to list everything in the shot, plus the sun. Select anything from the list to work on it.',
      done: 'Opened',
    },
    'h-top': {
      title: 'Look from above',
      text: 'Click Top, or press T, for the floor plan. It is the quickest way to check where everyone stands.',
      done: 'Switched',
    },
    'h-camera': {
      title: 'Look through the camera',
      text: 'Click Camera, or press C, to see the shot as the AI model will see it.',
      done: 'Switched',
    },
    'h-cambar': {
      title: 'The camera bar',
      text: 'Set start and Set end save the first and last framing, and the camera moves between them. Record lets you operate the camera live, and Location photo puts a real place behind the scene.',
    },
    'h-focus': {
      title: 'Pull focus',
      text: 'The tour framed the person for you. Double-click them to pull focus onto them.',
      done: 'Focused',
    },
    'h-play': {
      title: 'Play the shot',
      text: 'Click Play, or press Space, to run the shot from start to end.',
      done: 'Playing',
    },
    'h-key': {
      title: 'Keyframes',
      text: 'Key saves the selected item\'s position at the playhead. Blue tags on the timeline mark changes in a person\'s action.',
    },
    'h-shots': {
      title: 'Shots',
      text: 'Your shots appear in this row, and + New shot adds another camera setup.',
    },
    'h-take': {
      title: 'Takes',
      text: 'Take saves an alternative version of the whole scene. Switch between takes to compare ideas.',
    },
    'h-gear': {
      title: 'Advanced controls',
      text: 'Open the gear menu and switch on Advanced controls when you want finer detail. Leave them off for now.',
    },
    'h-export': {
      title: 'Export',
      text: 'Click Export to find the video, still frame and frame pack. You know your way round, and the Quick start page has the rest.',
      done: 'Opened',
    },
  },
};
