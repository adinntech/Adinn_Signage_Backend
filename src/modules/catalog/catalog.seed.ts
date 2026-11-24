// GENERATED ONCE from the phone's built-in catalog (lib/data/catalog/signage_catalog.dart, 2026-11-24). After the first run the database is the master:
// edit the catalog in the admin screens, not here. The seed only adds entries whose code / id is missing; it never overwrites an edit.
import type { CatalogSeed } from './catalog.types';

export const CATALOG_SEED: CatalogSeed = {
  "media": [
    {
      "code": "GSB",
      "shortName": "GSB",
      "name": "GSB Board (Glow Sign Board)",
      "description": "Back-lit flex/ACP box with LED modules inside an MS frame.",
      "icon": "lightbulb_outline",
      "color": "#D71920",
      "illuminated": true,
      "sidedness": "SELECTABLE",
      "depthFt": 0.75,
      "thicknessMm": 0.0,
      "template": "gsb",
      "installations": [
        "shop_fascia",
        "wall_mount",
        "double_pole",
        "single_pole",
        "rooftop",
        "support_pipe"
      ],
      "legacy": false,
      "order": 0
    },
    {
      "code": "NLB",
      "shortName": "NLB",
      "name": "Non-Lit Board",
      "description": "Flex or vinyl on a sun-board/MS frame, no illumination.",
      "icon": "crop_landscape",
      "color": "#1A73E8",
      "illuminated": false,
      "sidedness": "SELECTABLE",
      "depthFt": 0.25,
      "thicknessMm": 0.0,
      "template": "nonlit",
      "installations": [
        "shop_fascia",
        "wall_mount",
        "double_pole",
        "single_pole",
        "rooftop",
        "support_pipe"
      ],
      "legacy": false,
      "order": 1
    },
    {
      "code": "ACP",
      "shortName": "ACP 3D",
      "name": "ACP 3D (Raised Letters)",
      "description": "ACP cladding with acrylic / SS raised letters.",
      "icon": "text_fields",
      "color": "#455A64",
      "illuminated": true,
      "sidedness": "SINGLE",
      "depthFt": 0.4,
      "thicknessMm": 4.0,
      "template": "acp3d",
      "installations": [
        "shop_fascia",
        "wall_mount",
        "rooftop",
        "support_pipe"
      ],
      "legacy": false,
      "order": 9
    },
    {
      "code": "FLANGE",
      "shortName": "Flange",
      "name": "Flange / Projecting Board",
      "description": "Double-sided board projecting out from the wall or pole.",
      "icon": "flag_outlined",
      "color": "#7B1FA2",
      "illuminated": true,
      "sidedness": "SINGLE",
      "depthFt": 0.5,
      "thicknessMm": 0.0,
      "template": "",
      "installations": [
        "flange_bracket",
        "single_pole"
      ],
      "legacy": true,
      "order": 1003
    },
    {
      "code": "VINYL",
      "shortName": "Vinyl",
      "name": "Vinyl / One-Way Vision",
      "description": "Printed vinyl pasted on glass, shutter or door.",
      "icon": "window_outlined",
      "color": "#00897B",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.02,
      "thicknessMm": 0.0,
      "template": "",
      "installations": [
        "glass_pasting",
        "direct_wall"
      ],
      "legacy": true,
      "order": 1004
    },
    {
      "code": "WALL",
      "shortName": "Wall Paint",
      "name": "Wall Painting / Wall Branding",
      "description": "Hand / stencil painted branding directly on the wall.",
      "icon": "format_paint_outlined",
      "color": "#E37400",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.02,
      "thicknessMm": 0.0,
      "template": "",
      "installations": [
        "direct_wall"
      ],
      "legacy": true,
      "order": 1005
    },
    {
      "code": "SSTANDEE",
      "shortName": "Standee 1S",
      "name": "Single-Sided Standee",
      "description": "Freestanding board outside the shop with one visible advertising face, on a supporting frame and ground base.",
      "icon": "signpost_outlined",
      "color": "#5D4037",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.15,
      "thicknessMm": 0.0,
      "template": "",
      "installations": [
        "free_standing"
      ],
      "legacy": true,
      "order": 1006
    },
    {
      "code": "DSTANDEE",
      "shortName": "Standee 2S",
      "name": "Double-Sided Standee",
      "description": "One freestanding board with artwork on both front and back faces (quantity counts physical standees, not faces).",
      "icon": "view_agenda_outlined",
      "color": "#283593",
      "illuminated": false,
      "sidedness": "DOUBLE",
      "depthFt": 0.3,
      "thicknessMm": 0.0,
      "template": "",
      "installations": [
        "free_standing"
      ],
      "legacy": true,
      "order": 1007
    },
    {
      "code": "FOAM_VINYL",
      "shortName": "Foam Vinyl",
      "name": "Foam Board with Vinyl",
      "description": "Printed vinyl on a thin foam / sun-board substrate.",
      "icon": "layers_outlined",
      "color": "#6D4C41",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.02,
      "thicknessMm": 5.0,
      "template": "foam",
      "installations": [
        "wall_mount",
        "direct_wall"
      ],
      "legacy": false,
      "order": 2
    },
    {
      "code": "ACRYLIC",
      "shortName": "Acrylic",
      "name": "Clear Acrylic",
      "description": "Transparent acrylic panel with printed / applied graphics.",
      "icon": "crop_square",
      "color": "#0097A7",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.03,
      "thicknessMm": 8.0,
      "template": "acrylic",
      "installations": [
        "wall_mount",
        "shop_fascia",
        "glass_pasting"
      ],
      "legacy": false,
      "order": 3
    },
    {
      "code": "SANDWICH",
      "shortName": "Sandwich",
      "name": "Sandwich Board (A-Frame)",
      "description": "Portable A-frame with a display panel on each side.",
      "icon": "change_history",
      "color": "#8D6E63",
      "illuminated": false,
      "sidedness": "DOUBLE",
      "depthFt": 0.1,
      "thicknessMm": 6.0,
      "template": "sandwich",
      "installations": [
        "free_standing"
      ],
      "legacy": false,
      "order": 4
    },
    {
      "code": "OWV",
      "shortName": "One-Way",
      "name": "One-Way Vision",
      "description": "Perforated printed film applied on glass.",
      "icon": "blur_on",
      "color": "#00897B",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.01,
      "thicknessMm": 0.2,
      "template": "owv",
      "installations": [
        "glass_pasting"
      ],
      "legacy": false,
      "order": 5
    },
    {
      "code": "PLAIN_VINYL",
      "shortName": "Plain Vinyl",
      "name": "Plain Vinyl",
      "description": "Printed / cut vinyl applied on a wall, glass or door.",
      "icon": "wallpaper",
      "color": "#43A047",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.01,
      "thicknessMm": 0.1,
      "template": "vinyl",
      "installations": [
        "direct_wall",
        "glass_pasting"
      ],
      "legacy": false,
      "order": 6
    },
    {
      "code": "ACP2D",
      "shortName": "ACP 2D",
      "name": "ACP 2D (Flat Artwork)",
      "description": "Flat ACP panel with applied 2D artwork, no raised letters.",
      "icon": "rectangle_outlined",
      "color": "#546E7A",
      "illuminated": false,
      "sidedness": "SINGLE",
      "depthFt": 0.25,
      "thicknessMm": 4.0,
      "template": "acp2d",
      "installations": [
        "shop_fascia",
        "wall_mount",
        "support_pipe",
        "rooftop"
      ],
      "legacy": false,
      "order": 7
    },
    {
      "code": "ACP2D_DS",
      "shortName": "ACP 2D DS",
      "name": "ACP 2D – Double-Sided",
      "description": "ACP display with artwork on both front and rear faces.",
      "icon": "flip",
      "color": "#607D8B",
      "illuminated": false,
      "sidedness": "DOUBLE",
      "depthFt": 0.3,
      "thicknessMm": 4.0,
      "template": "acp2d",
      "installations": [
        "single_pole",
        "double_pole",
        "support_pipe",
        "rooftop"
      ],
      "legacy": false,
      "order": 8
    },
    {
      "code": "ACP3D_DS",
      "shortName": "ACP 3D DS",
      "name": "ACP 3D – Double-Sided",
      "description": "ACP structure with raised letters on both faces.",
      "icon": "text_rotation_none",
      "color": "#37474F",
      "illuminated": true,
      "sidedness": "DOUBLE",
      "depthFt": 0.5,
      "thicknessMm": 4.0,
      "template": "acp3d",
      "installations": [
        "single_pole",
        "double_pole",
        "support_pipe",
        "rooftop"
      ],
      "legacy": false,
      "order": 10
    },
    {
      "code": "MDF_GSB",
      "shortName": "MDF+GSB",
      "name": "MDF Board with GSB",
      "description": "MDF backing / frame with an integrated glow sign box.",
      "icon": "view_quilt_outlined",
      "color": "#AD1457",
      "illuminated": true,
      "sidedness": "SINGLE",
      "depthFt": 0.75,
      "thicknessMm": 18.0,
      "template": "mdfgsb",
      "installations": [
        "shop_fascia",
        "wall_mount",
        "support_pipe"
      ],
      "legacy": false,
      "order": 11
    },
    {
      "code": "MDF_GSB_DS",
      "shortName": "MDF+GSB DS",
      "name": "MDF Board with GSB – Double-Sided",
      "description": "MDF structure with glow sign faces on front and rear.",
      "icon": "view_agenda",
      "color": "#880E4F",
      "illuminated": true,
      "sidedness": "DOUBLE",
      "depthFt": 0.9,
      "thicknessMm": 18.0,
      "template": "mdfgsb",
      "installations": [
        "single_pole",
        "double_pole",
        "support_pipe",
        "rooftop"
      ],
      "legacy": false,
      "order": 12
    }
  ],
  "installations": [
    {
      "code": "shop_fascia",
      "name": "Shop Fascia",
      "description": "Fixed on the shop front elevation above the shutter.",
      "icon": "storefront_outlined",
      "order": 0
    },
    {
      "code": "wall_mount",
      "name": "Wall Mount",
      "description": "Fixed on a side / compound wall with anchors.",
      "icon": "wallpaper_outlined",
      "order": 1
    },
    {
      "code": "double_pole",
      "name": "Double Pole",
      "description": "Free-standing board on two MS/GI poles with footing.",
      "icon": "view_column_outlined",
      "order": 2
    },
    {
      "code": "single_pole",
      "name": "Single Pole",
      "description": "Free-standing board on a single central pole.",
      "icon": "signpost_outlined",
      "order": 3
    },
    {
      "code": "rooftop",
      "name": "Rooftop",
      "description": "MS structure erected on the terrace / roof.",
      "icon": "roofing_outlined",
      "order": 4
    },
    {
      "code": "flange_bracket",
      "name": "Flange Bracket",
      "description": "Projecting board on wall brackets.",
      "icon": "open_in_full",
      "order": 5
    },
    {
      "code": "direct_wall",
      "name": "Direct on Wall",
      "description": "Painted / pasted directly on the wall surface.",
      "icon": "format_paint_outlined",
      "order": 6
    },
    {
      "code": "glass_pasting",
      "name": "Glass / Shutter Pasting",
      "description": "Pasted on glass panels, doors or rolling shutters.",
      "icon": "door_sliding_outlined",
      "order": 7
    },
    {
      "code": "free_standing",
      "name": "Free Standing (Ground)",
      "description": "Standee placed on the ground outside / inside the shop.",
      "icon": "signpost_outlined",
      "order": 8
    },
    {
      "code": "support_pipe",
      "name": "Support Pipe",
      "description": "Board held off the wall / parapet on MS support pipes.",
      "icon": "view_week_outlined",
      "order": 9
    }
  ],
  "questions": [
    {
      "scope": "COMMON",
      "id": "existing_board",
      "label": "Is there an existing board at this location?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "COMMON",
      "id": "remove_existing",
      "label": "Existing board removal required?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "showIfId": "existing_board",
      "showIfValue": true,
      "order": 1
    },
    {
      "scope": "COMMON",
      "id": "access_method",
      "label": "Access method for installation",
      "type": "CHOICE",
      "options": [
        "Ladder",
        "Scaffolding",
        "Crane / Hydra",
        "Direct reach"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "COMMON",
      "id": "owner_permission",
      "label": "Shop owner permission obtained?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 3
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "shop_fascia",
      "id": "fascia_material",
      "label": "Fascia material",
      "type": "CHOICE",
      "options": [
        "Concrete",
        "Brick",
        "Metal sheet",
        "Wooden"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "shop_fascia",
      "id": "shutter_height",
      "label": "Shutter top height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "shop_fascia",
      "id": "neighbour_clearance",
      "label": "Clear of neighbouring boards?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "wall_mount",
      "id": "wall_type",
      "label": "Wall type",
      "type": "CHOICE",
      "options": [
        "Brick",
        "Concrete",
        "Metal sheet",
        "Stone"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "wall_mount",
      "id": "wall_condition",
      "label": "Wall condition",
      "type": "CHOICE",
      "options": [
        "Good",
        "Average",
        "Poor"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "wall_mount",
      "id": "mount_height",
      "label": "Board bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "pole_height",
      "label": "Clear height below board (pole height)",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "hint": "Ground to board bottom",
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "pole_gap",
      "label": "Distance between poles",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "ground_type",
      "label": "Ground type at pole location",
      "type": "CHOICE",
      "options": [
        "Soil",
        "Concrete",
        "Tar road",
        "Footpath tiles"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "foundation_depth",
      "label": "Foundation pit depth possible",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 3
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "pole_material",
      "label": "Pole material",
      "type": "CHOICE",
      "options": [
        "MS pipe",
        "GI pipe",
        "MS channel"
      ],
      "required": true,
      "order": 4
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "double_pole",
      "id": "excavation_permission",
      "label": "Excavation permission available?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 5
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "single_pole",
      "id": "pole_height",
      "label": "Clear height below board (pole height)",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "single_pole",
      "id": "pole_diameter",
      "label": "Pole diameter",
      "type": "CHOICE",
      "options": [
        "4 inch",
        "6 inch",
        "8 inch"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "single_pole",
      "id": "ground_type",
      "label": "Ground type at pole location",
      "type": "CHOICE",
      "options": [
        "Soil",
        "Concrete",
        "Tar road",
        "Footpath tiles"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "single_pole",
      "id": "foundation_depth",
      "label": "Foundation pit depth possible",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 3
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "building_floors",
      "label": "Number of floors (incl. ground)",
      "type": "NUMBER",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "roof_type",
      "label": "Roof type",
      "type": "CHOICE",
      "options": [
        "RCC slab",
        "Metal sheet",
        "Tiles"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "structure_height",
      "label": "Structure height above roof",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "terrace_access",
      "label": "Terrace access available?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 3
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "wind_exposure",
      "label": "Wind exposure",
      "type": "CHOICE",
      "options": [
        "Low",
        "Medium",
        "High"
      ],
      "required": true,
      "order": 4
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "rooftop",
      "id": "building_noc",
      "label": "Building owner NOC available?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 5
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "flange_bracket",
      "id": "mount_height",
      "label": "Board bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "flange_bracket",
      "id": "projection",
      "label": "Projection from wall",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "flange_bracket",
      "id": "wall_type",
      "label": "Wall type",
      "type": "CHOICE",
      "options": [
        "Brick",
        "Concrete",
        "Metal sheet",
        "Stone"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "direct_wall",
      "id": "mount_height",
      "label": "Artwork bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "direct_wall",
      "id": "wall_obstruction",
      "label": "Wall free of pipes / wires / obstructions?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "glass_pasting",
      "id": "panel_count",
      "label": "Number of glass / shutter panels",
      "type": "NUMBER",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "glass_pasting",
      "id": "mount_height",
      "label": "Artwork bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": false,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "free_standing",
      "id": "panel_bottom_height",
      "label": "Display panel bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "hint": "Clear height below the board",
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "free_standing",
      "id": "standee_surface",
      "label": "Ground surface at standee location",
      "type": "CHOICE",
      "options": [
        "Footpath tiles",
        "Concrete",
        "Soil",
        "Tar road",
        "Shop floor"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "free_standing",
      "id": "pedestrian_clearance",
      "label": "Leaves walking space / does not block entry?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 2
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "support_pipe",
      "id": "mount_height",
      "label": "Board bottom height from ground",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "support_pipe",
      "id": "pipe_count",
      "label": "Number of support pipes",
      "type": "NUMBER",
      "options": [],
      "required": true,
      "order": 1
    },
    {
      "scope": "INSTALLATION",
      "scopeCode": "support_pipe",
      "id": "pipe_length",
      "label": "Support pipe length",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "GSB",
      "id": "power_available",
      "label": "Electrical point available within 10 ft?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "GSB",
      "id": "power_distance",
      "label": "Distance to nearest power point",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "showIfId": "power_available",
      "showIfValue": false,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "GSB",
      "id": "light_type",
      "label": "Illumination type",
      "type": "CHOICE",
      "options": [
        "LED modules",
        "LED strip",
        "Tube lights"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "GSB",
      "id": "timer_required",
      "label": "Timer switch required?",
      "type": "YES_NO",
      "options": [],
      "required": false,
      "order": 3
    },
    {
      "scope": "MEDIA",
      "scopeCode": "NLB",
      "id": "front_light",
      "label": "Front focus lights required?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "NLB",
      "id": "frame_material",
      "label": "Frame material",
      "type": "CHOICE",
      "options": [
        "MS square tube",
        "Aluminium",
        "Wooden"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP",
      "id": "letter_type",
      "label": "3D letter type",
      "type": "CHOICE",
      "options": [
        "Acrylic LED letters",
        "Non-lit acrylic",
        "SS letters"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP",
      "id": "letter_height",
      "label": "Main letter height",
      "type": "NUMBER",
      "options": [],
      "unit": "in",
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP",
      "id": "acp_colour",
      "label": "ACP base colour",
      "type": "CHOICE",
      "options": [
        "Brand red",
        "White",
        "Silver",
        "Black"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "FLANGE",
      "id": "sides",
      "label": "Board sides",
      "type": "CHOICE",
      "options": [
        "Single side",
        "Double side"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "FLANGE",
      "id": "power_available",
      "label": "Electrical point available within 10 ft?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "VINYL",
      "id": "surface",
      "label": "Pasting surface",
      "type": "CHOICE",
      "options": [
        "Glass",
        "Rolling shutter",
        "Door",
        "Wall"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "VINYL",
      "id": "vinyl_type",
      "label": "Vinyl type",
      "type": "CHOICE",
      "options": [
        "One-way vision",
        "Opaque vinyl",
        "Frosted film"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "VINYL",
      "id": "surface_clean",
      "label": "Surface clean and dry?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "WALL",
      "id": "wall_surface",
      "label": "Wall surface condition",
      "type": "CHOICE",
      "options": [
        "Plastered",
        "Unplastered",
        "Old paint",
        "Damp / seepage"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "WALL",
      "id": "primer_required",
      "label": "Putty / primer required?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "overall_height",
      "label": "Overall standee height (ground to top)",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "display_panel_height",
      "label": "Display panel (artwork) height",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": false,
      "hint": "Leave empty when it equals the standee height",
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "base_type",
      "label": "Base type",
      "type": "CHOICE",
      "options": [
        "Flat MS base plate",
        "Weighted / sand base",
        "Water-fill base",
        "Ground-fixed (bolted / embedded)"
      ],
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "base_width",
      "label": "Base width",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 3
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "base_depth",
      "label": "Base depth",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 4
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "support_structure",
      "label": "Support structure",
      "type": "CHOICE",
      "options": [
        "Twin side posts",
        "Single centre pole",
        "A-frame",
        "Box frame"
      ],
      "required": true,
      "order": 5
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "standee_material",
      "label": "Board material",
      "type": "CHOICE",
      "options": [
        "Flex on MS frame",
        "ACP sheet",
        "Sunboard",
        "GI sheet",
        "Acrylic"
      ],
      "required": true,
      "order": 6
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "placement_location",
      "label": "Placement location",
      "type": "TEXT",
      "options": [],
      "required": true,
      "hint": "e.g. Footpath, left of shop entrance",
      "order": 7
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor",
      "type": "CHOICE",
      "options": [
        "Outdoor",
        "Indoor"
      ],
      "required": true,
      "order": 8
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SSTANDEE",
      "id": "standee_remarks",
      "label": "Standee remarks",
      "type": "TEXT",
      "options": [],
      "required": false,
      "order": 9
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "overall_height",
      "label": "Overall standee height (ground to top)",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "base_type",
      "label": "Base type",
      "type": "CHOICE",
      "options": [
        "Flat MS base plate",
        "Weighted / sand base",
        "Water-fill base",
        "Ground-fixed (bolted / embedded)"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "base_width",
      "label": "Base width",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 2
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "base_depth",
      "label": "Base depth",
      "type": "NUMBER",
      "options": [],
      "unit": "ft",
      "required": true,
      "order": 3
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "support_structure",
      "label": "Support structure",
      "type": "CHOICE",
      "options": [
        "Twin side posts",
        "Single centre pole",
        "A-frame",
        "Box frame"
      ],
      "required": true,
      "order": 4
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "standee_material",
      "label": "Board material",
      "type": "CHOICE",
      "options": [
        "Flex on MS frame",
        "ACP sheet",
        "Sunboard",
        "GI sheet",
        "Acrylic"
      ],
      "required": true,
      "order": 5
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "placement_location",
      "label": "Placement location",
      "type": "TEXT",
      "options": [],
      "required": true,
      "hint": "e.g. Footpath, left of shop entrance",
      "order": 6
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor",
      "type": "CHOICE",
      "options": [
        "Outdoor",
        "Indoor"
      ],
      "required": true,
      "order": 7
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "standee_remarks",
      "label": "Standee remarks",
      "type": "TEXT",
      "options": [],
      "required": false,
      "order": 8
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "front_face",
      "label": "Front face details (artwork / brand / direction)",
      "type": "TEXT",
      "options": [],
      "required": true,
      "order": 9
    },
    {
      "scope": "MEDIA",
      "scopeCode": "DSTANDEE",
      "id": "back_face",
      "label": "Back face details (artwork / brand / direction)",
      "type": "TEXT",
      "options": [],
      "required": true,
      "order": 10
    },
    {
      "scope": "MEDIA",
      "scopeCode": "FOAM_VINYL",
      "id": "surface",
      "label": "Mounting surface",
      "type": "CHOICE",
      "options": [
        "Wall",
        "Glass",
        "Door",
        "Shutter"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "FOAM_VINYL",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor",
      "type": "CHOICE",
      "options": [
        "Indoor",
        "Outdoor"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACRYLIC",
      "id": "standoff_mounting",
      "label": "Standoff (spacer) mounting?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACRYLIC",
      "id": "graphics_type",
      "label": "Graphics",
      "type": "CHOICE",
      "options": [
        "Reverse printed",
        "Vinyl applied",
        "Plain / etched"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SANDWICH",
      "id": "placement_location",
      "label": "Placement location",
      "type": "TEXT",
      "options": [],
      "required": true,
      "hint": "e.g. Footpath, left of shop entrance",
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "SANDWICH",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor",
      "type": "CHOICE",
      "options": [
        "Outdoor",
        "Indoor"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "OWV",
      "id": "surface_clean",
      "label": "Glass clean and dry?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "PLAIN_VINYL",
      "id": "surface",
      "label": "Pasting surface",
      "type": "CHOICE",
      "options": [
        "Glass",
        "Rolling shutter",
        "Door",
        "Wall"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "PLAIN_VINYL",
      "id": "surface_clean",
      "label": "Surface clean and dry?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP2D",
      "id": "acp_colour",
      "label": "ACP base colour",
      "type": "CHOICE",
      "options": [
        "Brand red",
        "White",
        "Silver",
        "Black"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP2D_DS",
      "id": "acp_colour",
      "label": "ACP base colour",
      "type": "CHOICE",
      "options": [
        "Brand red",
        "White",
        "Silver",
        "Black"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP3D_DS",
      "id": "letter_type",
      "label": "3D letter type",
      "type": "CHOICE",
      "options": [
        "Acrylic LED letters",
        "Non-lit acrylic",
        "SS letters"
      ],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "ACP3D_DS",
      "id": "letter_height",
      "label": "Main letter height",
      "type": "NUMBER",
      "options": [],
      "unit": "in",
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "MDF_GSB",
      "id": "power_available",
      "label": "Electrical point available within 10 ft?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "MDF_GSB",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor (MDF needs site review outdoors)",
      "type": "CHOICE",
      "options": [
        "Indoor",
        "Outdoor - covered",
        "Outdoor - exposed"
      ],
      "required": true,
      "order": 1
    },
    {
      "scope": "MEDIA",
      "scopeCode": "MDF_GSB_DS",
      "id": "power_available",
      "label": "Electrical point available within 10 ft?",
      "type": "YES_NO",
      "options": [],
      "required": true,
      "order": 0
    },
    {
      "scope": "MEDIA",
      "scopeCode": "MDF_GSB_DS",
      "id": "indoor_outdoor",
      "label": "Indoor / Outdoor (MDF needs site review outdoors)",
      "type": "CHOICE",
      "options": [
        "Indoor",
        "Outdoor - covered",
        "Outdoor - exposed"
      ],
      "required": true,
      "order": 1
    }
  ]
};
