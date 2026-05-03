I want to add a sidebar toggle in teh work tab, that open up a pane on the right side of whatever chat or cli sessoins you have in view in the ade work tab. Ok so right now there are a coupl eof things that all independentlay open up to the
  right, there is a proof drawer, which is currently tied per chat, there is an app control drawer and an ios drawer also per chat, then separetly theres a whole panel, that if you tkae your mouse all the way to the right side of the screen, has a popup
  arrow appear which pulls out the floating pane with a bunch of options. Now heres the reality of this. Things have changed, the onlt thing that really ahs any need to be tied to a chat is the proof drawer. I dont see any reason that the app contorl
  and the ios drawer cannot be per lane, i mean they run an app from a certain pwd, which for all chats within the same lane, theyre all he same. Now with the floating pane, we have git, files, stack, diff, and work. Now over here, i wanna remove stack
  and work, and diff. Heres the new directoin i wanna take. A gobal sidebar toggle button or somehtign indicative of a sidebar on the right poppin out. In the drawer, im expecting a sliding out drawer that sompeltely splits the screen. Right now, the
  app cotnrol and the ios sim drawer are th eonly ones that have the fully splut ui right, so look at that. Anyways, in this new drawer i wanna show first the git view, which should just be the git actions pane in the lanes tab (which also currenlty
  shows int eh pop out pane), but with the lane of the chat that the drawer is open from. So state of the current chat is what populates the items in this new pane. So the tabs in order are gonna be the git tab, files tab, ios sim drawer, and the app
  contorl drawer. Now all of these are tied to the current lane of the open chat or cli session or normal chat.

  Now i want to make sure that in the work tab, this new slide out drawer on the right is global in the sense that if u have it open, no matter what session or what u choose it stays open, but as u navigate sessions omethigns will chage. For exmaple, if
  u select a session in a diff lane then info ahs to populate to that new lane. For git and files, this is easy just display info for that lane. For the ios and app control tabs we have to keep it open, but show a clear wanring that they waere laucnehd
  from a different xyz lane, not this one, and so the user cannot attach context and scrrenshots to chat. Also we have to show the cannot attach context to chat message hwen looking at a cli session or shell session even if in the same lane. Rmemeber
  that for both fo these views ade has a system whe reu can highlight different elements and cpmponents and a screenshot with context pack gets added, but only works for ade chats.

  Now for the new chat pane, the lside out drawer shoulst still wok, but of course be popualted based on the lane selected in teh lane picker in teh new chat view. So like there is no case int eh work tab where a clear lane the user is "working in" is
  not in veiw. In the new chat view, autoamtaiclly primary is selected as the lane, so we show primary, but if the user goes to the dorpwdown and choose a diff one then of course we change the info in the pane. The only view which if confusing, is the
  grid view, as many chats from different lanes can be open, if the user goes to grid view we auto close and hide the slide out drawer, but as soon as they leave, we reopen/reshow.

  So to recap this is a "global" view that keeps state as in the open tab and he views as long as naviagtinv sessoins in the same lane, but the info repopulates for different lanes, but we keep the same tab open int eh slide our drawer.

  I wnat to think of this as its own system, not really tied to the cahts specificalkly but to the work tab as a whole, and diff lanes can be shown as info in there.

  Also, for the files tab, the one in the current pop oput floaitng pane sucks, its really old, in the new view please make sure the files tab looks like the real files tab in teh ade sidebar.
  This is a huge architecture change, so please carefully make edits, and clean up all legcay and dead code as to not leave behind old code not needed. So once again we need to comepltely get rid of and delete the current floating pop up pane stuff, all
  of ti, its getting refactored into this new view.

  Also leave the roof drawer alone, since that truly is per chat.

  For all this work, consider .claude/commands/optimize.md, i dont want yout o direclty run this, becuase this sessoins is currenlty running in the ade desktop app via npm run dev, and if u start a new ade session, this one will crash meaning this chat
  ends. U cannot spin up a new ade instance, since we are running in ade right. U have to take into condersation the things in this slash commadn though, and try to maek this enw feature as perofmative as possivle.

  Use parallel agents as needed