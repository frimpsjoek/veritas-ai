-- flatten-reveal.lua: make a revealjs-authored deck renderable as PowerPoint.
-- pandoc's pptx writer knows only headings, paragraphs, lists, images, tables, two columns and speaker
-- notes.  Everything revealjs-specific is turned into one of those:
--   .lead                 -> bold paragraph
--   .callout-*            -> "**Title.**" paragraph + body
--   .flow (.box / .arrow) -> one paragraph "box -> box -> box"
--   .question             -> italic paragraph
--   .fragment/.incremental/.rows/.bigtable/.small/.equal -> classes dropped, content kept
--   .columns / .column    -> kept (pandoc renders two columns); width attributes dropped
--   .notes                -> kept (speaker notes)
--   [text]{.peach .good .bad .muted ...} -> plain text
--   images: .svg -> .png when the PNG exists next to it (pptx cannot embed SVG reliably)

local function has(classes, name)
  for _, c in ipairs(classes) do
    if c == name then return true end
  end
  return false
end

local function strip_dirs(p)
  return p:gsub("^%./", "")
end

local function file_exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

function Image(el)
  local src = strip_dirs(el.src)
  if src:match("%.svg$") then
    local png = src:gsub("%.svg$", ".png")
    if file_exists(png) then el.src = png end
  elseif not src:match("%.%a+$") then
    -- revealjs decks omit the extension (default-image-extension: svg); prefer PNG for pptx
    if file_exists(src .. ".png") then el.src = src .. ".png"
    elseif file_exists(src .. ".svg") then el.src = src .. ".svg" end
  end
  -- width/height percentages mean nothing to pptx; let the layout size the picture
  el.attributes.width = nil
  el.attributes.height = nil
  return el
end

function Math(el)
  local s = el.text
  s = s:gsub("\\mathrm{([^}]*)}", "%1"):gsub("\\text{([^}]*)}", "%1")
  s = s:gsub("\\times", "x"):gsub("\\le", "≤"):gsub("\\ge", "≥"):gsub("\\to", "→")
  s = s:gsub("\\,", " "):gsub("\\;", " ")
  s = s:gsub("\\(%a+)", "%1"):gsub("[{}]", "")      -- \alpha -> alpha, \epsilon_\infty -> epsilon_infty
  return pandoc.Str(s)
end

function Span(el)
  -- colour / size spans carry no meaning in pptx; keep the text
  return el.content
end

local function inlines_of(blocks)
  -- concatenate the inline content of a list of blocks, separated by spaces
  local out = pandoc.Inlines({})
  for i, b in ipairs(blocks) do
    if i > 1 then out:insert(pandoc.Space()) end
    if b.t == "Plain" or b.t == "Para" then
      for _, x in ipairs(b.content) do out:insert(x) end
    else
      for _, x in ipairs(pandoc.utils.blocks_to_inlines({b})) do out:insert(x) end
    end
  end
  return out
end

function Div(el)
  local c = el.classes
  if has(c, "notes") then
    return el                                   -- speaker notes: pandoc pptx understands this
  end
  if has(c, "lead") then
    return pandoc.Para({pandoc.Strong(inlines_of(el.content))})
  end
  if has(c, "question") then
    return pandoc.Para({pandoc.Emph(inlines_of(el.content))})
  end
  if has(c, "flow") then
    local parts = pandoc.Inlines({})
    for _, b in ipairs(el.content) do
      if b.t == "Div" and has(b.classes, "box") then
        if #parts > 0 then parts:insert(pandoc.Str(" → ")) end
        for _, x in ipairs(inlines_of(b.content)) do parts:insert(x) end
      end
    end
    return pandoc.Para(parts)
  end
  for _, cls in ipairs(c) do
    if cls:match("^callout%-") or cls == "callout" then
      local title = el.attributes["title"] or cls:gsub("^callout%-", ""):gsub("^%l", string.upper)
      local out = pandoc.List({pandoc.Para({pandoc.Strong({pandoc.Str(title .. ".")})})})
      for _, b in ipairs(el.content) do out:insert(b) end
      return out
    end
  end
  if has(c, "columns") then
    el.classes = pandoc.List({"columns"})
    -- pandoc's pptx writer uses the first two columns only: stack columns 3.. under column 2
    local cols = pandoc.List({})
    for _, x in ipairs(el.content) do
      if x.t == "Div" and has(x.classes, "column") then cols:insert(x) end
    end
    if #cols > 2 then
      for k = 3, #cols do
        for _, blk in ipairs(cols[k].content) do cols[2].content:insert(blk) end
      end
      el.content = pandoc.List({cols[1], cols[2]})
    end
    return el
  end
  if has(c, "column") then
    el.classes = pandoc.List({"column"})
    el.attributes = {}
    return el
  end
  -- fragment, incremental, rows, bigtable, small, equal, ...: unwrap
  return el.content
end

-- A pptx slide may hold ONE columns block and nothing else; pandoc moves any later block to a new,
-- untitled slide.  Fold blocks that follow a columns block into its last column (speaker notes stay
-- at the end of the slide).  Runs after the Div/Image/Span filters above.
local function fold_columns(blocks)
  local out = pandoc.List({})
  local i = 1
  while i <= #blocks do
    local b = blocks[i]
    out:insert(b)
    if b.t == "Header" and b.level == 2 then
      -- collect this slide's blocks
      local j = i + 1
      local slide = pandoc.List({})
      while j <= #blocks and not (blocks[j].t == "Header" and blocks[j].level <= 2) do
        slide:insert(blocks[j]); j = j + 1
      end
      -- find the columns div
      local ci = nil
      for k, sb in ipairs(slide) do
        if sb.t == "Div" and has(sb.classes, "columns") then ci = k break end
      end
      if not ci then
        -- lone image or table + other blocks: pandoc would split them over two slides; make two columns
        local ii = nil
        for k, sb in ipairs(slide) do
          if (sb.t == "Para" and #sb.content == 1 and sb.content[1].t == "Image") or sb.t == "Table" then ii = k break end
        end
        if ii and #slide > 1 then
          local img, rest, notes = slide[ii], pandoc.List({}), pandoc.List({})
          for k, sb in ipairs(slide) do
            if k ~= ii then
              if sb.t == "Div" and has(sb.classes, "notes") then notes:insert(sb) else rest:insert(sb) end
            end
          end
          if #rest > 0 then
            local c1 = pandoc.Div(pandoc.List({img}), pandoc.Attr("", {"column"}))
            local c2 = pandoc.Div(rest, pandoc.Attr("", {"column"}))
            slide = pandoc.List({pandoc.Div(pandoc.List({c1, c2}), pandoc.Attr("", {"columns"}))})
            for _, x in ipairs(notes) do slide:insert(x) end
            ci = 1
          end
        end
      end
      if ci then
        local cols = slide[ci]
        local before, after, notes = pandoc.List({}), pandoc.List({}), pandoc.List({})
        for k, sb in ipairs(slide) do
          if k < ci then before:insert(sb)
          elseif k > ci then
            if sb.t == "Div" and has(sb.classes, "notes") then notes:insert(sb) else after:insert(sb) end
          end
        end
        -- blocks before the columns (lead sentence) go to the first column, after -> last column
        local first, last = nil, nil
        for _, c in ipairs(cols.content) do
          if c.t == "Div" and has(c.classes, "column") then
            if not first then first = c end
            last = c
          end
        end
        if first and last then
          -- pandoc keeps only the picture of a column that holds a picture: move that column's text
          -- (captions) and the trailing blocks to a text-only column, else leave them after the
          -- columns (pandoc then makes a continuation slide) and say so.
          local function is_media(x)
            return (x.t == "Para" and #x.content == 1 and x.content[1].t == "Image") or x.t == "Table"
          end
          local function has_image(col)
            for _, x in ipairs(col.content) do
              if is_media(x) then return true end
            end
            return false
          end
          local textcol = nil
          for _, c in ipairs(cols.content) do
            if c.t == "Div" and has(c.classes, "column") and not has_image(c) then textcol = c end
          end
          local spill = pandoc.List({})
          for _, c in ipairs(cols.content) do
            if c.t == "Div" and has(c.classes, "column") and has_image(c) then
              local keep = pandoc.List({})
              for _, x in ipairs(c.content) do
                if is_media(x) then keep:insert(x) else spill:insert(x) end
              end
              c.content = keep
            end
          end
          for _, x in ipairs(after) do spill:insert(x) end
          if textcol then
            if textcol == first then
              local fc = pandoc.List({})
              for _, x in ipairs(before) do fc:insert(x) end
              for _, x in ipairs(first.content) do fc:insert(x) end
              first.content = fc
            else
              for _, x in ipairs(before) do out:insert(x) end
            end
            for _, x in ipairs(spill) do textcol.content:insert(x) end
            out:insert(cols)
          else
            for _, x in ipairs(before) do out:insert(x) end
            out:insert(cols)
            if #spill > 0 then
              io.stderr:write("flatten-reveal: slide '" .. pandoc.utils.stringify(b) ..
                "': both columns hold pictures; text continues on an extra slide\n")
              for _, x in ipairs(spill) do out:insert(x) end
            end
          end
          for _, x in ipairs(notes) do out:insert(x) end
        else
          for _, x in ipairs(slide) do out:insert(x) end
        end
      else
        for _, x in ipairs(slide) do out:insert(x) end
      end
      i = j
    else
      i = i + 1
    end
  end
  return out
end

function Pandoc(doc)
  local n = 0
  for _, b in ipairs(doc.blocks) do if b.t == "Header" then n = n + 1 end end
  if os.getenv("FLATTEN_DEBUG") then io.stderr:write("flatten-reveal: top-level headers = " .. n .. ", blocks = " .. #doc.blocks .. "\n") end
  doc.blocks = fold_columns(doc.blocks)
  return doc
end
